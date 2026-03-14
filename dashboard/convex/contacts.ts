import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.status) {
      return ctx.db
        .query("contacts")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    }
    return ctx.db.query("contacts").collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    role: v.optional(v.string()),
    status: v.string(),
    lastInteraction: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("contacts", args);
  },
});

export const update = mutation({
  args: {
    id: v.id("contacts"),
    status: v.optional(v.string()),
    notes: v.optional(v.string()),
    lastInteraction: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    return ctx.db.patch(id, fields);
  },
});
