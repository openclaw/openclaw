/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { pgTable, text, serial, integer, bigint, boolean, timestamp, uuid, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  path: text("path").notNull(),
  r2Key: text("r2_key"), // Cloudflare R2 storage key
  r2Url: text("r2_url"), // Cloudflare R2 public URL
  size: bigint("size", { mode: "number" }).notNull(), // BIGINT to support files >2GB
  duration: text("duration"),
  width: integer("width"), // Video width in pixels
  height: integer("height"), // Video height in pixels
  aspectRatio: text("aspect_ratio"), // Detected aspect ratio (16:9 or 9:16)
  userEmail: text("user_email"), // Email for delivery notifications
  sessionId: text("session_id"), // Link to payment session
  processed: boolean("processed").default(false),
  videoTitle: text("video_title"), // Optional custom video title
  artistInfo: text("artist_info"), // Optional artist/song information
  uploadedAt: timestamp("uploaded_at").defaultNow(), // For 24-hour retention tracking
  expiresAt: timestamp("expires_at"), // Calculated 24 hours from upload
  // Removed watermark tracking - CUTMV is now a paid-only service with clean exports
});

export const clips = pgTable("clips", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").references(() => videos.id),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  filename: text("filename").notNull(),
  path: text("path"),
  processed: boolean("processed").default(false),
});

// Email delivery tracking
export const emailDeliveries = pgTable("email_deliveries", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userEmail: text("user_email").notNull(),
  emailType: text("email_type").notNull(), // 'processing_started' | 'download_ready'
  messageId: text("message_id"), // Resend message ID
  status: text("status").default("pending"), // 'pending' | 'sent' | 'delivered' | 'failed'
  downloadUrl: text("download_url"), // For download_ready emails
  downloadFilename: text("download_filename"),
  processingDetails: text("processing_details"), // JSON string
  sentAt: timestamp("sent_at").defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  errorMessage: text("error_message"),
});

// Background processing jobs
export const backgroundJobs = pgTable("background_jobs", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  videoId: integer("video_id").references(() => videos.id),
  userEmail: text("user_email").notNull(),
  jobType: text("job_type").notNull(), // 'video_processing'
  status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'completed' | 'failed'
  progress: integer("progress").notNull().default(0), // 0-100
  processingDetails: text("processing_details"), // JSON string with options
  downloadPath: text("download_path"), // Final download URL
  r2DownloadUrl: text("r2_download_url"), // R2 download URL
  professionalQuality: boolean("professional_quality").default(true), // All exports are professional quality
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"), // 29 days from completion for exports
  // Unified deadline tracking
  deadlineTime: timestamp("deadline_time"),
  totalTimeoutMinutes: integer("total_timeout_minutes"),
  videoDurationMinutes: real("video_duration_minutes"),
});

// Authentication Tables
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"), // User's full name from onboarding
  marketingConsent: boolean("marketing_consent").default(false), // Consent for marketing emails
  onboardingCompleted: boolean("onboarding_completed").default(false), // Track if user completed onboarding
  referralCode: text("referral_code").unique(), // User's unique referral code
  referredBy: text("referred_by"), // Referral code of who referred this user
  credits: integer("credits").default(0), // Available purchased/referral credits (don't expire)
  subscriptionCredits: integer("subscription_credits").default(0), // Monthly subscription credits (reset each billing cycle)
  subscriptionCreditResetDate: timestamp("subscription_credit_reset_date"), // Next date when subscription credits reset
  referralCount: integer("referral_count").default(0), // Total successful referrals
  lastCreditGrantAt: timestamp("last_credit_grant_at"), // Rate limiting
  stripeCustomerId: text("stripe_customer_id"), // Stripe customer ID for billing
  stripeSubscriptionId: text("stripe_subscription_id"), // Active Stripe subscription ID
  paymentFailedCount: integer("payment_failed_count").default(0), // Consecutive failed payment attempts
  lastPaymentFailedAt: timestamp("last_payment_failed_at"), // Timestamp of last failed payment
  createdAt: timestamp("created_at").defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const magicLinks = pgTable("magic_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  verificationCode: text("verification_code"), // 6-digit code for manual entry
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
  usedAt: timestamp("used_at"), // Track when first used for grace period (email scanner protection)
  createdAt: timestamp("created_at").defaultNow(),
});

export const exports = pgTable("exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  videoId: integer("video_id").references(() => videos.id),
  filename: text("filename").notNull(),
  originalVideoName: text("original_video_name"), // Original upload filename for reference
  format: text("format").notNull(), // 'cutdown', 'gif', 'thumbnail', 'canvas'
  aspectRatio: text("aspect_ratio"), // '16:9' or '9:16'
  timestampCount: integer("timestamp_count"), // Number of clips generated
  downloadUrl: text("download_url"),
  r2Key: text("r2_key"),
  fileSize: bigint("file_size", { mode: "number" }), // BIGINT to support exports >2GB
  status: text("status").notNull().default("processing"), // 'processing', 'completed', 'failed', 'expired'
  expiresAt: timestamp("expires_at").notNull(), // 29 days from completion
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

// Referral System Tables
export const referralEvents = pgTable("referral_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  referrerId: uuid("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referredId: uuid("referred_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // 'signup', 'first_export', 'purchase'
  ipAddress: text("ip_address"), // For abuse prevention
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const creditTransactions = pgTable("credit_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  transactionType: text("transaction_type").notNull(), // 'earned', 'spent', 'expired'
  amount: integer("amount").notNull(), // Credits gained or lost
  note: text("note"), // Description of transaction
  referralEventId: uuid("referral_event_id").references(() => referralEvents.id),
  expiresAt: timestamp("expires_at"), // Credit expiration (60 days)
  createdAt: timestamp("created_at").defaultNow(),
});

export const referralTracking = pgTable("referral_tracking", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(), // Browser session
  referralCode: text("referral_code").notNull(), // Code from URL
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  landingPage: text("landing_page"), // Where they landed
  converted: boolean("converted").default(false), // Whether they signed up
  convertedUserId: uuid("converted_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertVideoSchema = createInsertSchema(videos).pick({
  filename: true,
  originalName: true,
  path: true,
  r2Key: true,
  r2Url: true,
  size: true,
  videoTitle: true,
  artistInfo: true,
  duration: true,
  userEmail: true,
  sessionId: true,
});

export const insertEmailDeliverySchema = createInsertSchema(emailDeliveries).pick({
  sessionId: true,
  userEmail: true,
  emailType: true,
  messageId: true,
  status: true,
  downloadUrl: true,
  downloadFilename: true,
  processingDetails: true,
  errorMessage: true,
});

export const insertBackgroundJobSchema = createInsertSchema(backgroundJobs).pick({
  sessionId: true,
  videoId: true,
  userEmail: true,
  jobType: true,
  status: true,
  progress: true,
  processingDetails: true,
  downloadPath: true,
  r2DownloadUrl: true,
  errorMessage: true,
  deadlineTime: true,
  totalTimeoutMinutes: true,
  videoDurationMinutes: true,
});

export const insertClipSchema = createInsertSchema(clips).pick({
  videoId: true,
  startTime: true,
  endTime: true,
  filename: true,
  path: true,
});

export const timestampSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
});

export const timestampListSchema = z.array(timestampSchema);

// Referral system schemas
export const insertReferralEventSchema = createInsertSchema(referralEvents).pick({
  referrerId: true,
  referredId: true,
  eventType: true,
  ipAddress: true,
  userAgent: true,
});

export const insertCreditTransactionSchema = createInsertSchema(creditTransactions).pick({
  userId: true,
  transactionType: true,
  amount: true,
  note: true,
  referralEventId: true,
  expiresAt: true,
});

export const insertReferralTrackingSchema = createInsertSchema(referralTracking).pick({
  sessionId: true,
  referralCode: true,
  ipAddress: true,
  userAgent: true,
  landingPage: true,
  converted: true,
  convertedUserId: true,
});

// Referral validation schemas
export const referralCodeSchema = z.object({
  code: z.string().min(6).max(20),
});

export const redeemCreditSchema = z.object({
  amount: z.number().min(1),
  purpose: z.string(),
});

export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type Video = typeof videos.$inferSelect;
export type InsertClip = z.infer<typeof insertClipSchema>;
export type Clip = typeof clips.$inferSelect;
export type Timestamp = z.infer<typeof timestampSchema>;
export type InsertEmailDelivery = z.infer<typeof insertEmailDeliverySchema>;
export type EmailDelivery = typeof emailDeliveries.$inferSelect;
export type InsertBackgroundJob = z.infer<typeof insertBackgroundJobSchema>;
export type InsertReferralEvent = z.infer<typeof insertReferralEventSchema>;
export type ReferralEvent = typeof referralEvents.$inferSelect;
export type InsertCreditTransaction = z.infer<typeof insertCreditTransactionSchema>;
export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type InsertReferralTracking = z.infer<typeof insertReferralTrackingSchema>;
export type ReferralTracking = typeof referralTracking.$inferSelect;
export type BackgroundJob = typeof backgroundJobs.$inferSelect;

// Auth Types
export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  name: true,
  marketingConsent: true,
  onboardingCompleted: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
});

export const insertSessionSchema = createInsertSchema(sessions).pick({
  userId: true,
  token: true,
  expiresAt: true,
});

export const insertMagicLinkSchema = createInsertSchema(magicLinks).pick({
  email: true,
  token: true,
  expiresAt: true,
});

export const insertExportSchema = createInsertSchema(exports).pick({
  userId: true,
  videoId: true,
  filename: true,
  originalVideoName: true,
  format: true,
  aspectRatio: true,
  timestampCount: true,
  downloadUrl: true,
  r2Key: true,
  fileSize: true,
  status: true,
  expiresAt: true,
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Session = typeof sessions.$inferSelect;
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type MagicLink = typeof magicLinks.$inferSelect;
export type InsertMagicLink = z.infer<typeof insertMagicLinkSchema>;
export type Export = typeof exports.$inferSelect;
export type InsertExport = z.infer<typeof insertExportSchema>;

export interface ProcessingJob {
  id: number;
  videoId: number;
  isProcessing: boolean;
  progress: number;
  currentClip: number;
  totalClips: number;
  totalGifs: number;
  totalThumbnails: number;
  totalCanvas: number;
  totalOutputs: number;
  estimatedTimeLeft?: number;
  canCancel: boolean;
  downloadUrl?: string;
  error?: string;
  aspectRatios?: ('16:9' | '9:16')[];
}

// Payment and pricing schemas
export const pricingConfigSchema = z.object({
  cutdown16x9: z.number(), // Price per timestamp for 16:9
  cutdown9x16: z.number(), // Price per timestamp for 9:16
  spotifyCanvas: z.number(), // Price for 5 Spotify Canvas loops
  gifPack: z.number(), // Price for 10 GIFs
  thumbnailPack: z.number(), // Price for 10 thumbnails
  fullFeaturePack: z.number(), // Special price for GIFs + Canvas + Thumbnails
  // Removed: All exports are now professional quality by default
});

export const paymentRequestSchema = z.object({
  timestampText: z.string(),
  aspectRatios: z.array(z.enum(['16:9', '9:16'])),
  generateGif: z.boolean(),
  generateThumbnails: z.boolean(),
  generateCanvas: z.boolean(),
  useFullPack: z.boolean().optional(),
  discountCode: z.string().optional(),
  videoId: z.number().optional(), // Video ID for processing and email notifications
  userEmail: z.string().optional(), // Email for delivery - validated separately when needed
  emailOptIn: z.boolean().optional(), // User consent for marketing emails
  // Fade effects for music videos
  videoFade: z.boolean().optional(),
  audioFade: z.boolean().optional(),
  fadeDuration: z.number().optional(),
  // Removed: All exports are now professional quality by default
});

// Promo code validation schema
export const promoCodeValidationSchema = z.object({
  code: z.string(),
  isValid: z.boolean(),
  discountPercentage: z.number(),
  message: z.string(),
  expiresAt: z.string().optional(),
});

export type PromoCodeValidation = z.infer<typeof promoCodeValidationSchema>;

export const paymentSessionSchema = z.object({
  sessionId: z.string(),
  timestampText: z.string(),
  aspectRatios: z.array(z.enum(['16:9', '9:16'])),
  generateGif: z.boolean(),
  generateThumbnails: z.boolean(),
  generateCanvas: z.boolean(),
  totalAmount: z.number(),
  paid: z.boolean(),
  userEmail: z.string().email().optional(), // Email for delivery notifications
});

export type PricingConfig = z.infer<typeof pricingConfigSchema>;
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;
export type PaymentSession = z.infer<typeof paymentSessionSchema>;
