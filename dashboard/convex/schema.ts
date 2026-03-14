import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  activities: defineTable({
    type: v.string(),
    agentId: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
  }).index("by_timestamp", ["timestamp"]),

  calendarEvents: defineTable({
    title: v.string(),
    start: v.number(),
    end: v.number(),
    type: v.optional(v.string()),
    color: v.optional(v.string()),
    description: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
  }).index("by_start", ["start"]),

  tasks: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
    priority: v.string(),
    assignee: v.optional(v.string()),
    category: v.optional(v.string()),
    dueDate: v.optional(v.number()),
  }).index("by_status", ["status"]),

  contacts: defineTable({
    name: v.string(),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    role: v.optional(v.string()),
    status: v.string(),
    lastInteraction: v.optional(v.number()),
    notes: v.optional(v.string()),
  }).index("by_status", ["status"]),

  contentDrafts: defineTable({
    title: v.string(),
    body: v.optional(v.string()),
    platform: v.optional(v.string()),
    status: v.string(),
    scheduledFor: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  ecosystemProducts: defineTable({
    name: v.string(),
    slug: v.string(),
    status: v.string(),
    description: v.optional(v.string()),
    health: v.optional(v.string()),
    metrics: v.optional(v.any()),
  }).index("by_slug", ["slug"]),
});
