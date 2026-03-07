/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { 
  videos, 
  clips, 
  emailDeliveries, 
  backgroundJobs,
  users,
  type Video, 
  type InsertVideo, 
  type Clip, 
  type InsertClip,
  type EmailDelivery,
  type InsertEmailDelivery,
  type BackgroundJob,
  type InsertBackgroundJob,
  type User,
  type InsertUser
} from "@shared/schema";
import { randomUUID } from "crypto";
import { db } from "./db";
import { eq, or, and, desc } from "drizzle-orm";

export interface IStorage {
  // Video operations
  createVideo(video: InsertVideo): Promise<Video>;
  getVideo(id: number): Promise<Video | undefined>;
  updateVideo(id: number, updates: Partial<Video>): Promise<Video | undefined>;
  deleteVideo(id: number): Promise<boolean>;
  
  // Clip operations
  createClip(clip: InsertClip): Promise<Clip>;
  getClipsByVideoId(videoId: number): Promise<Clip[]>;
  updateClip(id: number, updates: Partial<Clip>): Promise<Clip | undefined>;
  deleteClip(id: number): Promise<boolean>;
  deleteClipsByVideoId(videoId: number): Promise<boolean>;
  
  // Email delivery operations
  createEmailDelivery(delivery: InsertEmailDelivery): Promise<EmailDelivery>;
  getEmailDelivery(id: number): Promise<EmailDelivery | undefined>;
  getEmailDeliveriesBySession(sessionId: string): Promise<EmailDelivery[]>;
  updateEmailDelivery(id: number, updates: Partial<EmailDelivery>): Promise<EmailDelivery | undefined>;
  
  // Background job operations
  createBackgroundJob(job: InsertBackgroundJob): Promise<BackgroundJob>;
  getBackgroundJob(sessionId: string): Promise<BackgroundJob | undefined>;
  getBackgroundJobById(id: number): Promise<BackgroundJob | undefined>;
  updateBackgroundJob(sessionId: string, updates: Partial<BackgroundJob>): Promise<BackgroundJob | undefined>;
  getUserVideos(userEmail: string): Promise<Video[]>;
  getUserBackgroundJobs(userEmail: string): Promise<BackgroundJob[]>;
  getActiveBackgroundJobs(): Promise<BackgroundJob[]>;
  getActiveJobsByUser(userEmail: string): Promise<BackgroundJob[]>;
  
  // User operations
  createUser(user: InsertUser): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  getUserByReferralCode(referralCode: string): Promise<User | undefined>;
}

export class MemStorage implements IStorage {
  private videos: Map<number, Video>;
  private clips: Map<number, Clip>;
  private emailDeliveries: Map<number, EmailDelivery>;
  private backgroundJobs: Map<string, BackgroundJob>; // keyed by sessionId
  private users: Map<string, User>; // keyed by user ID
  private currentVideoId: number;
  private currentClipId: number;
  private currentEmailId: number;
  private currentJobId: number;

  constructor() {
    this.videos = new Map();
    this.clips = new Map();
    this.emailDeliveries = new Map();
    this.backgroundJobs = new Map();
    this.users = new Map();
    this.currentVideoId = 1;
    this.currentClipId = 1;
    this.currentEmailId = 1;
    this.currentJobId = 1;
  }

  // Video operations
  async createVideo(insertVideo: InsertVideo): Promise<Video> {
    const id = this.currentVideoId++;
    const now = new Date();
    const video: Video = { 
      ...insertVideo, 
      id, 
      processed: false,
      userEmail: insertVideo.userEmail || null,
      sessionId: insertVideo.sessionId || null,
      r2Key: insertVideo.r2Key || null,
      r2Url: insertVideo.r2Url || null,
      duration: insertVideo.duration || null,
      width: (insertVideo as any).width || null,
      height: (insertVideo as any).height || null,
      aspectRatio: (insertVideo as any).aspectRatio || null,
      videoTitle: insertVideo.videoTitle || null,
      artistInfo: insertVideo.artistInfo || null,
      uploadedAt: now,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
    };
    this.videos.set(id, video);
    return video;
  }

  async getVideo(id: number): Promise<Video | undefined> {
    return this.videos.get(id);
  }

  async updateVideo(id: number, updates: Partial<Video>): Promise<Video | undefined> {
    const video = this.videos.get(id);
    if (!video) return undefined;
    
    const updatedVideo = { ...video, ...updates };
    this.videos.set(id, updatedVideo);
    return updatedVideo;
  }

  async deleteVideo(id: number): Promise<boolean> {
    return this.videos.delete(id);
  }

  // Clip operations
  async createClip(insertClip: InsertClip): Promise<Clip> {
    const id = this.currentClipId++;
    const clip: Clip = { 
      ...insertClip, 
      id, 
      processed: false,
      path: insertClip.path || null,
      videoId: insertClip.videoId || null
    };
    this.clips.set(id, clip);
    return clip;
  }

  async getClipsByVideoId(videoId: number): Promise<Clip[]> {
    return Array.from(this.clips.values()).filter(clip => clip.videoId === videoId);
  }

  async updateClip(id: number, updates: Partial<Clip>): Promise<Clip | undefined> {
    const clip = this.clips.get(id);
    if (!clip) return undefined;
    
    const updatedClip = { ...clip, ...updates };
    this.clips.set(id, updatedClip);
    return updatedClip;
  }

  async deleteClip(id: number): Promise<boolean> {
    return this.clips.delete(id);
  }

  async deleteClipsByVideoId(videoId: number): Promise<boolean> {
    const clipsToDelete = Array.from(this.clips.entries())
      .filter(([_, clip]) => clip.videoId === videoId)
      .map(([id, _]) => id);
    
    clipsToDelete.forEach(id => this.clips.delete(id));
    return true;
  }

  // Email delivery operations
  async createEmailDelivery(insertDelivery: InsertEmailDelivery): Promise<EmailDelivery> {
    const id = this.currentEmailId++;
    const delivery: EmailDelivery = {
      ...insertDelivery,
      id,
      status: insertDelivery.status || 'pending',
      messageId: insertDelivery.messageId || null,
      downloadUrl: insertDelivery.downloadUrl || null,
      downloadFilename: insertDelivery.downloadFilename || null,
      processingDetails: insertDelivery.processingDetails || null,
      sentAt: (insertDelivery as any).sentAt || new Date(),
      deliveredAt: null,
      errorMessage: insertDelivery.errorMessage || null
    };
    this.emailDeliveries.set(id, delivery);
    return delivery;
  }

  async getEmailDelivery(id: number): Promise<EmailDelivery | undefined> {
    return this.emailDeliveries.get(id);
  }

  async getEmailDeliveriesBySession(sessionId: string): Promise<EmailDelivery[]> {
    return Array.from(this.emailDeliveries.values()).filter(delivery => delivery.sessionId === sessionId);
  }

  async updateEmailDelivery(id: number, updates: Partial<EmailDelivery>): Promise<EmailDelivery | undefined> {
    const delivery = this.emailDeliveries.get(id);
    if (!delivery) return undefined;
    
    const updatedDelivery = { ...delivery, ...updates };
    this.emailDeliveries.set(id, updatedDelivery);
    return updatedDelivery;
  }

  // Background job operations
  async createBackgroundJob(insertJob: InsertBackgroundJob): Promise<BackgroundJob> {
    const id = this.currentJobId++;
    const job: BackgroundJob = {
      ...insertJob,
      id,
      status: insertJob.status || 'pending',
      processingDetails: insertJob.processingDetails || null,
      professionalQuality: (insertJob as any).professionalQuality || true,
      videoId: insertJob.videoId || null,
      downloadPath: insertJob.downloadPath || null,
      r2DownloadUrl: insertJob.r2DownloadUrl || null,
      errorMessage: insertJob.errorMessage || null,
      progress: insertJob.progress || 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      expiresAt: null, // Will be set when job completes (29 days from completion)
      deadlineTime: (insertJob as any).deadlineTime || null,
      totalTimeoutMinutes: (insertJob as any).totalTimeoutMinutes || null,
      videoDurationMinutes: (insertJob as any).videoDurationMinutes || null
    };
    this.backgroundJobs.set(insertJob.sessionId, job);
    return job;
  }

  async getBackgroundJob(sessionId: string): Promise<BackgroundJob | undefined> {
    return this.backgroundJobs.get(sessionId);
  }

  async getBackgroundJobById(id: number): Promise<BackgroundJob | undefined> {
    return Array.from(this.backgroundJobs.values()).find(job => job.id === id);
  }

  async updateBackgroundJob(sessionId: string, updates: Partial<BackgroundJob>): Promise<BackgroundJob | undefined> {
    const job = this.backgroundJobs.get(sessionId);
    if (!job) return undefined;
    
    const updatedJob = { 
      ...job, 
      ...updates,
      status: updates.status || job.status || 'pending',
      progress: updates.progress !== undefined ? updates.progress : job.progress,
      // Set expiration to 29 days when job completes
      expiresAt: updates.status === 'completed' && !job.expiresAt ? 
        new Date(Date.now() + 29 * 24 * 60 * 60 * 1000) : 
        (updates.expiresAt !== undefined ? updates.expiresAt : job.expiresAt)
    };
    this.backgroundJobs.set(sessionId, updatedJob);
    return updatedJob;
  }

  async getActiveBackgroundJobs(): Promise<BackgroundJob[]> {
    return Array.from(this.backgroundJobs.values()).filter(job => 
      job.status === 'pending' || job.status === 'processing'
    );
  }

  async getUserVideos(userEmail: string): Promise<Video[]> {
    return Array.from(this.videos.values()).filter(video => 
      video.userEmail === userEmail
    );
  }

  async getUserBackgroundJobs(userEmail: string): Promise<BackgroundJob[]> {
    return Array.from(this.backgroundJobs.values()).filter(job => 
      job.userEmail === userEmail
    );
  }

  async getActiveJobsByUser(userEmail: string): Promise<BackgroundJob[]> {
    return Array.from(this.backgroundJobs.values()).filter(job => 
      job.userEmail === userEmail && (job.status === 'pending' || job.status === 'processing')
    );
  }

  // User operations
  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    // Generate a unique referral code
    const referralCode = this.generateReferralCode();
    
    const user: User = {
      ...insertUser,
      id,
      email: insertUser.email,
      name: insertUser.name || null,
      marketingConsent: insertUser.marketingConsent || false,
      onboardingCompleted: insertUser.onboardingCompleted || false,
      referralCode,
      referredBy: null,
      credits: 0,
      subscriptionCredits: 0,
      subscriptionCreditResetDate: null,
      referralCount: 0,
      lastCreditGrantAt: null,
      stripeCustomerId: insertUser.stripeCustomerId || null,
      stripeSubscriptionId: insertUser.stripeSubscriptionId || null,
      paymentFailedCount: 0,
      lastPaymentFailedAt: null,
      createdAt: new Date(),
      lastLoginAt: null,
    };
    this.users.set(id, user);
    return user;
  }

  private generateReferralCode(): string {
    // Generate a unique 12-character referral code similar to the reference image
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < 12; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    // Ensure uniqueness by checking existing codes
    const existingUser = Array.from(this.users.values()).find(user => user.referralCode === code);
    if (existingUser) {
      return this.generateReferralCode(); // Recursive call if collision
    }
    
    return code;
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.email === email);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    
    const updatedUser = { ...user, ...updates };
    this.users.set(id, updatedUser);
    return updatedUser;
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  async getUserByReferralCode(referralCode: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.referralCode === referralCode);
  }
}

// PostgreSQL implementation using Drizzle ORM
export class PostgresStorage implements IStorage {
  // Video operations
  async createVideo(video: InsertVideo): Promise<Video> {
    const [created] = await db.insert(videos).values(video).returning();
    return created;
  }

  async getVideo(id: number): Promise<Video | undefined> {
    const [video] = await db.select().from(videos).where(eq(videos.id, id));
    return video;
  }

  async updateVideo(id: number, updates: Partial<Video>): Promise<Video | undefined> {
    const [updated] = await db.update(videos).set(updates).where(eq(videos.id, id)).returning();
    return updated;
  }

  async deleteVideo(id: number): Promise<boolean> {
    const result = await db.delete(videos).where(eq(videos.id, id));
    return result.rowCount! > 0;
  }

  // Clip operations
  async createClip(clip: InsertClip): Promise<Clip> {
    const [created] = await db.insert(clips).values(clip).returning();
    return created;
  }

  async getClipsByVideoId(videoId: number): Promise<Clip[]> {
    return await db.select().from(clips).where(eq(clips.videoId, videoId));
  }

  async updateClip(id: number, updates: Partial<Clip>): Promise<Clip | undefined> {
    const [updated] = await db.update(clips).set(updates).where(eq(clips.id, id)).returning();
    return updated;
  }

  async deleteClip(id: number): Promise<boolean> {
    const result = await db.delete(clips).where(eq(clips.id, id));
    return result.rowCount! > 0;
  }

  async deleteClipsByVideoId(videoId: number): Promise<boolean> {
    const result = await db.delete(clips).where(eq(clips.videoId, videoId));
    return result.rowCount! > 0;
  }

  // Email delivery operations
  async createEmailDelivery(delivery: InsertEmailDelivery): Promise<EmailDelivery> {
    const [created] = await db.insert(emailDeliveries).values(delivery).returning();
    return created;
  }

  async getEmailDelivery(id: number): Promise<EmailDelivery | undefined> {
    const [delivery] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, id));
    return delivery;
  }

  async getEmailDeliveriesBySession(sessionId: string): Promise<EmailDelivery[]> {
    return await db.select().from(emailDeliveries).where(eq(emailDeliveries.sessionId, sessionId));
  }

  async updateEmailDelivery(id: number, updates: Partial<EmailDelivery>): Promise<EmailDelivery | undefined> {
    const [updated] = await db.update(emailDeliveries).set(updates).where(eq(emailDeliveries.id, id)).returning();
    return updated;
  }

  // Background job operations
  async createBackgroundJob(job: InsertBackgroundJob): Promise<BackgroundJob> {
    const [created] = await db.insert(backgroundJobs).values(job).returning();
    return created;
  }

  async getBackgroundJob(sessionId: string): Promise<BackgroundJob | undefined> {
    const [job] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.sessionId, sessionId));
    return job;
  }

  async getBackgroundJobById(id: number): Promise<BackgroundJob | undefined> {
    const [job] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id));
    return job;
  }

  async updateBackgroundJob(sessionId: string, updates: Partial<BackgroundJob>): Promise<BackgroundJob | undefined> {
    const [updated] = await db.update(backgroundJobs).set(updates).where(eq(backgroundJobs.sessionId, sessionId)).returning();
    return updated;
  }

  async getActiveBackgroundJobs(): Promise<BackgroundJob[]> {
    return await db.select().from(backgroundJobs).where(
      or(
        eq(backgroundJobs.status, 'pending'),
        eq(backgroundJobs.status, 'processing')
      )
    );
  }

  // Get active jobs for a specific user
  async getActiveJobsByUser(userEmail: string): Promise<BackgroundJob[]> {
    return await db.select().from(backgroundJobs).where(
      and(
        eq(backgroundJobs.userEmail, userEmail),
        or(
          eq(backgroundJobs.status, 'pending'),
          eq(backgroundJobs.status, 'processing')
        )
      )
    );
  }

  async getUserVideos(userEmail: string): Promise<Video[]> {
    return await db.select().from(videos).where(eq(videos.userEmail, userEmail));
  }

  async getUserBackgroundJobs(userEmail: string): Promise<BackgroundJob[]> {
    return await db.select().from(backgroundJobs).where(eq(backgroundJobs.userEmail, userEmail));
  }

  async getBackgroundJobBySessionId(sessionId: string): Promise<BackgroundJob | null> {
    try {
      const result = await db.select()
        .from(backgroundJobs)
        .where(eq(backgroundJobs.sessionId, sessionId))
        .orderBy(desc(backgroundJobs.createdAt))
        .limit(1);
      return result[0] || null;
    } catch (error) {
      console.error('Error getting background job by session ID:', error);
      return null;
    }
  }

  // User operations (delegated to auth service)
  async createUser(user: InsertUser): Promise<User> {
    const [created] = await db.insert(users).values(user).returning();
    return created;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const [updated] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    return updated;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id));
    return result.rowCount! > 0;
  }

  async getUserByReferralCode(referralCode: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.referralCode, referralCode));
    return user;
  }
}

// Use PostgreSQL storage in production, keep MemStorage for fallback
export const storage = new PostgresStorage();
