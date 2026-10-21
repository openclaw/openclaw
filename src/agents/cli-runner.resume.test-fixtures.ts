export const failClosedPluginResumeCases: Array<{
  name: string;
  invalidate?: boolean;
  event?: Record<string, unknown>;
}> = [
  { name: "a valid required generation" },
  {
    name: "background work",
    invalidate: true,
    event: {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-1", task_type: "local_agent" }],
    },
  },
  {
    name: "an unknown event",
    invalidate: true,
    event: { type: "future_event" },
  },
];
