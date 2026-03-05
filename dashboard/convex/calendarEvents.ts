import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {
    start: v.optional(v.number()),
    end: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let q = ctx.db.query("calendarEvents").withIndex("by_start");
    const events = await q.collect();
    if (args.start && args.end) {
      return events.filter((e) => e.start >= args.start! && e.start <= args.end!);
    }
    return events;
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    start: v.number(),
    end: v.number(),
    type: v.optional(v.string()),
    color: v.optional(v.string()),
    description: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("calendarEvents", args);
  },
});

export const update = mutation({
  args: {
    id: v.id("calendarEvents"),
    title: v.optional(v.string()),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    type: v.optional(v.string()),
    color: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("calendarEvents") },
  handler: async (ctx, args) => {
    return ctx.db.delete(args.id);
  },
});
