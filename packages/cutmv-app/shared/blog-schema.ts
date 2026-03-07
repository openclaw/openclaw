// Blog Schema for CUTMV Whitepaper Generator
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod';

export const blogPosts = pgTable('blog_posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  slug: text('slug').notNull().unique(),
  content: text('content').notNull(),
  excerpt: text('excerpt').notNull(),
  author: text('author').notNull().default('Full Digital Team'),
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const blogPostInsertSchema = createInsertSchema(blogPosts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BlogPost = typeof blogPosts.$inferSelect;
export type BlogPostInsert = z.infer<typeof blogPostInsertSchema>;

export const generatePostSchema = z.object({
  topic: z.string().min(10, 'Topic must be at least 10 characters'),
  targetAudience: z.enum(['artists', 'labels', 'creators', 'general']).default('general'),
  tone: z.enum(['professional', 'casual', 'technical', 'cultural']).default('professional'),
});

export type GeneratePostRequest = z.infer<typeof generatePostSchema>;