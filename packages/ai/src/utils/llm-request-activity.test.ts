import { expect, it, vi } from "vitest";
import { notifyLlmRequestActivity, onLlmRequestActivity } from "./llm-request-activity.js";

it("keeps a replacement activity subscription when an old disposer runs again", () => {
  const signal = new AbortController().signal;
  const retired = vi.fn();
  const unsubscribe = onLlmRequestActivity(signal, retired);
  unsubscribe();
  const active = vi.fn();
  const stop = onLlmRequestActivity(signal, active);
  try {
    unsubscribe();
    notifyLlmRequestActivity(signal);
    expect(retired).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledOnce();
    stop();
    notifyLlmRequestActivity(signal);
    expect(active).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});
