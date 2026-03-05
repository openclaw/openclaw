import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.status) {
      return ctx.db
        .query("contentDrafts")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    }
    return ctx.db.query("contentDrafts").collect();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    body: v.optional(v.string()),
    platform: v.optional(v.string()),
    status: v.string(),
    scheduledFor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("contentDrafts", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("contentDrafts"),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    status: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("contentDrafts") },
  handler: async (ctx, args) => {
    return ctx.db.delete(args.id);
  },
});
