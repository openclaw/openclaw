import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  handler: async (ctx) => {
    return ctx.db.query("ecosystemProducts").collect();
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("ecosystemProducts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    status: v.string(),
    description: v.optional(v.string()),
    health: v.optional(v.string()),
    metrics: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("ecosystemProducts", args);
  },
});

export const update = mutation({
  args: {
    id: v.id("ecosystemProducts"),
    status: v.optional(v.string()),
    health: v.optional(v.string()),
    metrics: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    return ctx.db.patch(id, fields);
  },
});
