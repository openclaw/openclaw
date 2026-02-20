"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bot, Send, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { timeAgo, getPriorityStyle } from "@/lib/shared";
import type { Task, TaskComment } from "@/lib/hooks/use-tasks";
import { useCommentPolling } from "@/lib/hooks/use-polling";

interface TaskDetailModalProps {
  task: Task;
  onClose: () => void;
  onMoveToDone: () => Promise<boolean> | boolean;
  onRefresh: () => Promise<void> | void;
}

export function TaskDetailModal({
  task,
  onClose,
  onMoveToDone,
  onRefresh
}: TaskDetailModalProps) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const [reworkFeedback, setReworkFeedback] = useState("");
  const [showRework, setShowRework] = useState(false);
  const [reworking, setReworking] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(4);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [approvingDone, setApprovingDone] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/comments?taskId=${task.id}&workspace_id=${task.workspace_id}`);
      const data = await res.json();
      setComments(data.comments || []);
    } catch { } // retry on next interval
  }, [task.id, task.workspace_id]);

  const fetchCommentsWithLoading = useCallback(async () => {
    await fetchComments();
    setLoading(false);
  }, [fetchComments]);

  useCommentPolling(task.id, fetchCommentsWithLoading, onRefresh, 12_000);

  // Auto-scroll when new comments arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [comments.length]);

  const addUserComment = async () => {
    if (!newComment.trim() || sendingComment) return;
    setSendingComment(true);
    try {
      await fetch("/api/tasks/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, content: newComment.trim(), workspace_id: task.workspace_id }),
      });
      setNewComment("");
      await fetchComments();
    } catch { } finally {
      setSendingComment(false);
    }
  };

  const requestRework = async () => {
    if (!reworkFeedback.trim() || reworking) return;
    setReworking(true);
    try {
      await fetch("/api/tasks/rework", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, feedback: reworkFeedback.trim() }),
      });
      setReworkFeedback("");
      setShowRework(false);
      await fetchComments();
      await Promise.resolve(onRefresh());
    } catch { } finally {
      setReworking(false);
    }
  };

  const submitSpecialistFeedback = useCallback(async (): Promise<boolean> => {
    if (!task.assigned_agent_id) return true;
    try {
      const res = await fetch("/api/agents/specialists/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: task.assigned_agent_id,
          taskId: task.id,
          rating: feedbackRating,
          dimension: "overall",
          note: feedbackNote.trim() || undefined,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [feedbackNote, feedbackRating, task.assigned_agent_id, task.id]);

  const approveAndDone = async () => {
    if (approvingDone) return;
    setApprovingDone(true);
    setFeedbackError(null);
    const feedbackSaved = await submitSpecialistFeedback();
    if (!feedbackSaved) {
      setFeedbackError(
        "Feedback could not be saved, but task approval will continue."
      );
    }
    const moved = await Promise.resolve(onMoveToDone());
    if (!moved) {
      setFeedbackError("Task approval failed. Please retry.");
    }
    setApprovingDone(false);
  };

  const priority = getPriorityStyle(task.priority);
  const isAgentWorking = task.status === "in_progress" && !!task.assigned_agent_id;
  const isReview = task.status === "review";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[760px] max-h-[92vh] overflow-hidden p-0 flex flex-col">
        <div className="border-b border-border/60 px-5 py-4 pr-12">
          <DialogHeader className="text-left">
            <DialogTitle className="text-base leading-snug break-words">
              {task.title}
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2 pt-1">
              <Badge variant="outline" className={priority.className}>
                {priority.label}
              </Badge>
              <span className="text-xs uppercase text-muted-foreground">
                {task.status.replace("_", " ")}
              </span>
              {task.assigned_agent_id && (
                <button
                  onClick={() => {
                    window.location.hash = "specialists";
                    onClose();
                  }}
                  className="transition-opacity hover:opacity-80"
                  title="View Specialist Profile"
                >
                  <Badge variant="secondary" className="gap-1 cursor-pointer">
                    <Bot className="w-3 h-3" /> {task.assigned_agent_id}
                  </Badge>
                </button>
              )}
              {isAgentWorking && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary font-mono">
                  Agent working
                </span>
              )}
              {isReview && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500 font-mono">
                  Ready for review
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {task.description && (
            <section className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Task Brief
              </p>
              <ScrollArea className="mt-2 max-h-[170px] pr-2">
                <p className="text-sm leading-6 text-muted-foreground whitespace-pre-wrap break-words">
                  {task.description}
                </p>
              </ScrollArea>
            </section>
          )}

          {isAgentWorking && (
            <div className="flex items-center gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
              <div className="relative">
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-primary bg-primary/20">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-background">
                  <div className="h-2 w-2 rounded-full bg-green-500 animate-ping" />
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-primary">
                  {task.assigned_agent_id} is currently processing this task
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Responses appear in activity and will auto-sync.
                </p>
              </div>
            </div>
          )}

          <section className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">
              Activity ({comments.length})
            </h4>
            {loading ? (
              <div className="py-4 text-center text-sm text-muted-foreground animate-pulse">
                Loading activity...
              </div>
            ) : comments.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                No activity yet. Assign an agent to start this task.
              </div>
            ) : (
              <ScrollArea className="h-[240px] rounded-md border border-border/70 bg-card p-2">
                <div className="space-y-2 pr-1">
                  {comments.map((c) => (
                    <article
                      key={c.id}
                      className={`rounded-md border p-3 text-sm ${c.author_type === "agent"
                        ? "bg-primary/5 border-primary/20"
                        : c.author_type === "system"
                          ? "bg-blue-500/5 border-blue-500/20"
                          : "bg-amber-500/5 border-amber-500/20"
                        }`}
                    >
                      <p
                        className={`mb-1 text-[11px] font-bold uppercase ${c.author_type === "agent"
                          ? "text-primary"
                          : c.author_type === "system"
                            ? "text-blue-400"
                            : "text-amber-500"
                          }`}
                      >
                        {c.author_type === "agent"
                          ? `Agent ${c.agent_id || "unknown"}`
                          : c.author_type === "system"
                            ? "System"
                            : "You"}
                      </p>
                      <p className="text-[13px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                        {c.content}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {timeAgo(c.created_at)}
                      </p>
                    </article>
                  ))}
                  <div ref={scrollRef} />
                </div>
              </ScrollArea>
            )}
          </section>

          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addUserComment()}
              placeholder="Add a comment..."
              maxLength={5000}
            />
            <Button
              size="sm"
              disabled={!newComment.trim() || sendingComment}
              onClick={addUserComment}
            >
              <Send className="w-3 h-3" />
            </Button>
          </div>

          {isReview && (
            <div className="space-y-2 rounded-md border border-primary/20 bg-primary/5 p-3">
              <label className="text-sm font-medium text-primary">
                Specialist Quality Feedback
              </label>
              <div className="flex items-center gap-2">
                {[1, 2, 3, 4, 5].map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    onClick={() => setFeedbackRating(rating)}
                    className={`h-8 w-8 rounded-md border text-xs font-semibold transition-colors ${feedbackRating === rating
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-border hover:border-primary/40"
                      }`}
                    aria-label={`Set feedback rating to ${rating}`}
                  >
                    {rating}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground">
                  {feedbackRating}/5
                </span>
              </div>
              <input
                type="text"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={feedbackNote}
                onChange={(e) => setFeedbackNote(e.target.value)}
                placeholder="Optional note to help this specialist improve..."
                maxLength={2000}
              />
              {feedbackError && (
                <p className="text-xs text-amber-500">{feedbackError}</p>
              )}
            </div>
          )}

          {isReview && showRework && (
            <div className="space-y-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
              <label className="text-sm font-medium text-amber-500">
                Rework Instructions
              </label>
              <textarea
                className="min-h-[100px] w-full resize-y rounded-md border border-amber-500/30 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                value={reworkFeedback}
                onChange={(e) => setReworkFeedback(e.target.value)}
                placeholder="Describe what needs to be changed or improved..."
                autoFocus
                maxLength={2000}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowRework(false);
                    setReworkFeedback("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!reworkFeedback.trim() || reworking}
                  onClick={requestRework}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {reworking ? "Sending..." : "Send to Agent"}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border/60 px-5 py-4 gap-2 sm:justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {isReview && !showRework && (
            <Button
              variant="outline"
              onClick={() => setShowRework(true)}
              className="border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
            >
              Request Rework
            </Button>
          )}
          {isReview && (
            <Button
              onClick={() => void approveAndDone()}
              disabled={approvingDone}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <CheckCircle2 className="w-4 h-4 mr-1" />
              {approvingDone ? "Approving..." : "Approve & Done"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
