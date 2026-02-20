"use client";

import { useState, useMemo, useEffect } from "react";
import { Bot, Sparkles, X, LayoutTemplate, Search, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { Agent } from "@/lib/hooks/use-tasks";
import { suggestAgentForTask, SPECIALIZED_AGENTS } from "@/lib/agent-registry";
import {
  loadCommunityUsecaseFavorites,
  saveCommunityUsecaseFavorites,
  toggleCommunityUsecaseFavorite,
} from "@/lib/community-usecase-favorites";

interface CommunityUsecaseTemplate {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  rating: number;
  tags: string[];
  url?: string;
  source?: string;
  sourceDetail?: string;
}

interface CommunityUsecasesResponse {
  usecases?: CommunityUsecaseTemplate[];
  total?: number;
  error?: string;
}

interface CreateTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (data: {
    title: string;
    description: string;
    priority: string;
    assigned_agent_id?: string;
  }) => Promise<boolean> | boolean;
  agents: Agent[];
  seedDraft?: {
    title: string;
    description: string;
    priority: string;
    assigned_agent_id?: string;
  } | null;
  seedNonce?: number;
}

export function CreateTaskModal({
  open,
  onOpenChange,
  onCreate,
  agents,
  seedDraft,
  seedNonce,
}: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [agentId, setAgentId] = useState("none");
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templates, setTemplates] = useState<CommunityUsecaseTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [favoriteTemplateIds, setFavoriteTemplateIds] = useState<string[]>([]);

  // Match suggested specialist based on title and description
  const suggestedSpecialist = useMemo(() => {
    if (suggestionDismissed) return null;
    return suggestAgentForTask(`${title} ${description}`);
  }, [title, description, suggestionDismissed]);

  useEffect(() => {
    if (!open || templates.length > 0 || templatesLoading) return;
    let cancelled = false;

    async function loadTemplates() {
      setTemplatesLoading(true);
      setTemplatesError(null);
      try {
        const res = await fetch("/api/openclaw/community-usecases");
        const data = (await res.json()) as CommunityUsecasesResponse;
        if (!res.ok) {
          throw new Error(data.error || `Failed to load templates (${res.status})`);
        }
        if (!cancelled) {
          const incoming = Array.isArray(data.usecases) ? data.usecases : [];
          setTemplates(incoming);
        }
      } catch (error) {
        if (!cancelled) {
          setTemplatesError(error instanceof Error ? error.message : "Failed to load templates");
        }
      } finally {
        if (!cancelled) {
          setTemplatesLoading(false);
        }
      }
    }

    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [open, templates.length, templatesLoading]);

  useEffect(() => {
    if (!open || !seedDraft) return;
    setTitle(seedDraft.title || "");
    setDescription(seedDraft.description || "");
    setPriority(seedDraft.priority || "medium");
    setAgentId(seedDraft.assigned_agent_id || "none");
    setSuggestionDismissed(false);
    setSubmitError(null);
  }, [open, seedDraft, seedNonce]);

  useEffect(() => {
    setFavoriteTemplateIds(loadCommunityUsecaseFavorites());
  }, []);

  const favoriteTemplateSet = useMemo(
    () => new Set(favoriteTemplateIds),
    [favoriteTemplateIds]
  );

  const filteredTemplates = useMemo(() => {
    const query = templateQuery.toLowerCase().trim();
    const matching = !query
      ? templates
      : templates.filter((template) => {
        return (
          template.title.toLowerCase().includes(query) ||
          template.summary.toLowerCase().includes(query) ||
          template.category.toLowerCase().includes(query) ||
          template.tags.some((tag) => tag.toLowerCase().includes(query))
        );
      });

    return [...matching]
      .sort((a, b) => {
        const af = favoriteTemplateSet.has(a.id) ? 1 : 0;
        const bf = favoriteTemplateSet.has(b.id) ? 1 : 0;
        if (af !== bf) return bf - af;
        return b.rating - a.rating;
      })
      .slice(0, query ? 14 : 10);
  }, [templateQuery, templates, favoriteTemplateSet]);

  const favoriteTemplates = useMemo(
    () =>
      filteredTemplates
        .filter((template) => {
          return favoriteTemplateSet.has(template.id);
        })
        .slice(0, 6),
    [filteredTemplates, favoriteTemplateSet]
  );

  const handleToggleTemplateFavorite = (templateId: string) => {
    setFavoriteTemplateIds((prev) => {
      const next = toggleCommunityUsecaseFavorite(prev, templateId);
      saveCommunityUsecaseFavorites(next);
      return next;
    });
  };

  const buildTemplateTask = (template: CommunityUsecaseTemplate) => {
    const builtTitle = `Implement use case: ${template.title}`.slice(0, 200);
    const builtDescription = [
      "You are implementing this OpenClaw community use case in OpenClaw Mission Control.",
      "",
      `Use case: ${template.title}`,
      `Category: ${template.category}`,
      `Source: ${template.sourceDetail || template.source || "community catalog"}`,
      `Reference: ${template.url || "N/A"}`,
      "",
      `Summary: ${template.summary}`,
      "",
      "Delivery criteria:",
      "1. Add or improve a concrete feature in this workspace.",
      "2. Keep the implementation production-safe (types, error handling, tests or verifiable behavior).",
      "3. Leave a short note in task comments describing what changed.",
    ].join("\n");
    const builtPriority = template.rating >= 94 ? "high" : "medium";
    const templateSuggestion = suggestAgentForTask(`${template.title} ${template.summary}`);

    return {
      title: builtTitle,
      description: builtDescription,
      priority: builtPriority,
      suggestedAgentId: templateSuggestion?.id,
    };
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSuggestionDismissed(false);
      setSubmitError(null);
      setSubmitting(false);
      setTemplateQuery("");
      setTitle("");
      setDescription("");
      setPriority("medium");
      setAgentId("none");
    }
    onOpenChange(nextOpen);
  };

  const handleUseSuggestion = () => {
    if (suggestedSpecialist) {
      setAgentId(suggestedSpecialist.id);
    }
  };

  const submitTask = async (payload: {
    title: string;
    description: string;
    priority: string;
    assignedAgentId?: string;
  }) => {
    if (submitting) return false;
    setSubmitting(true);
    setSubmitError(null);
    const ok = await Promise.resolve(
      onCreate({
        title: payload.title.trim(),
        description: payload.description.trim(),
        priority: payload.priority,
        ...(payload.assignedAgentId ? { assigned_agent_id: payload.assignedAgentId } : {}),
      })
    );
    setSubmitting(false);
    if (!ok) {
      setSubmitError("Failed to create task. Please try again.");
      return;
    }

    setTitle("");
    setDescription("");
    setPriority("medium");
    setAgentId("none");
    setTemplateQuery("");
    setSuggestionDismissed(false);
    onOpenChange(false);
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    await submitTask({
      title,
      description,
      priority,
      assignedAgentId: agentId !== "none" ? agentId : undefined,
    });
  };

  const handleCreateAndDispatchCurrent = async () => {
    if (!title.trim() || submitting) return;
    const dispatchAgentId =
      agentId !== "none"
        ? agentId
        : suggestedSpecialist?.id;

    if (!dispatchAgentId) {
      setSubmitError(
        "No suggested specialist found. Pick an agent first, then use Create & Dispatch."
      );
      return;
    }

    await submitTask({
      title,
      description,
      priority,
      assignedAgentId: dispatchAgentId,
    });
  };

  const handleApplyTemplate = (template: CommunityUsecaseTemplate) => {
    const built = buildTemplateTask(template);
    setTitle(built.title);
    setDescription(built.description);
    setPriority(built.priority);
    if (built.suggestedAgentId) {
      setAgentId(built.suggestedAgentId);
    }
    setSuggestionDismissed(false);
    setSubmitError(null);
  };

  const handleTemplateCreateAndDispatch = async (template: CommunityUsecaseTemplate) => {
    if (submitting) return;
    const built = buildTemplateTask(template);
    const dispatchAgentId =
      built.suggestedAgentId || (agentId !== "none" ? agentId : undefined);

    if (!dispatchAgentId) {
      handleApplyTemplate(template);
      setSubmitError(
        "Template loaded. Pick an agent once, then click Create & Dispatch."
      );
      return;
    }

    await submitTask({
      title: built.title,
      description: built.description,
      priority: built.priority,
      assignedAgentId: dispatchAgentId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create New Task</DialogTitle>
          <DialogDescription>Add a new task to the inbox.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <LayoutTemplate className="w-4 h-4 text-primary" />
                  Community Usecase Templates
                </label>
                <span className="text-xs text-muted-foreground">
                  {templatesLoading ? "Loading..." : `${templates.length} imported`}
                </span>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  className="w-full pl-9 pr-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={templateQuery}
                  onChange={(e) => setTemplateQuery(e.target.value)}
                  placeholder="Search usecase templates..."
                />
              </div>
              {templatesError ? (
                <p className="text-xs text-destructive">{templatesError}</p>
              ) : (
                <>
                  {!templateQuery.trim() && favoriteTemplates.length > 0 && (
                    <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5">
                      <p className="text-xs font-medium text-primary mb-2">Favorite Templates</p>
                      <div className="flex flex-wrap gap-1.5">
                        {favoriteTemplates.map((template) => (
                          <button
                            key={`fav-${template.id}`}
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-background px-2 py-1 text-xs hover:bg-primary/10"
                            onClick={() => handleApplyTemplate(template)}
                          >
                            <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                            <span className="max-w-[180px] truncate">{template.title}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                    {filteredTemplates.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No matching templates. Clear search to see top imported usecases.
                      </p>
                    ) : (
                      filteredTemplates.map((template) => (
                        <div
                          key={template.id}
                          className="rounded-md border border-border/70 bg-muted/20 p-2.5 space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium leading-tight">{template.title}</p>
                              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                                {template.summary}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Badge variant="outline" className="text-[10px]">
                                {template.category}
                              </Badge>
                              <button
                                type="button"
                                className="h-6 w-6 rounded border border-border/60 bg-background flex items-center justify-center hover:bg-muted"
                                title={
                                  favoriteTemplateSet.has(template.id)
                                    ? "Remove from favorites"
                                    : "Add to favorites"
                                }
                                onClick={() => handleToggleTemplateFavorite(template.id)}
                              >
                                <Star
                                  className={`w-3.5 h-3.5 ${favoriteTemplateSet.has(template.id)
                                      ? "fill-amber-400 text-amber-400"
                                      : "text-muted-foreground"
                                    }`}
                                />
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-muted-foreground">
                              Score {template.rating}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => handleApplyTemplate(template)}
                                disabled={submitting}
                              >
                                Use
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => {
                                  void handleTemplateCreateAndDispatch(template);
                                }}
                                disabled={submitting}
                              >
                                Create & Dispatch
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <input
                type="text"
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                autoFocus
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <textarea
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[80px] resize-y"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional details..."
                maxLength={2000}
              />
            </div>
            {/* Suggested Agent Banner */}
            {suggestedSpecialist && agentId !== suggestedSpecialist.id && (
              <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <Sparkles className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-medium">Suggested:</span>{" "}
                    <span className="text-primary">{suggestedSpecialist.icon} {suggestedSpecialist.name}</span>
                    <span className="text-muted-foreground"> — {suggestedSpecialist.description}</span>
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 h-7 px-2 text-primary hover:text-primary hover:bg-primary/10"
                  onClick={handleUseSuggestion}
                >
                  Use
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 h-7 w-7 p-0"
                  onClick={() => setSuggestionDismissed(true)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}

            <div className="flex gap-3">
              <div className="space-y-2 flex-1">
                <label className="text-sm font-medium">Priority</label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 flex-1">
                <label className="text-sm font-medium">Assign to Agent</label>
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="No agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      <span className="text-muted-foreground">Unassigned</span>
                    </SelectItem>
                    {/* Gateway Agents */}
                    {agents.length > 0 && (
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        Gateway Agents
                      </div>
                    )}
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-1.5">
                          <Bot className="w-3 h-3" />
                          {a.name || a.id}
                        </span>
                      </SelectItem>
                    ))}
                    {/* AI Specialists */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-t mt-1 pt-1">
                      AI Specialists
                    </div>
                    {SPECIALIZED_AGENTS.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="flex items-center gap-1.5">
                          <span>{s.icon}</span>
                          {s.name}
                          {suggestedSpecialist?.id === s.id && (
                            <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 h-4">
                              Suggested
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {submitError && <p className="text-sm text-destructive">{submitError}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleDialogOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="outline" disabled={!title.trim() || submitting}>
              {submitting ? "Creating..." : "Create Task"}
            </Button>
            <Button
              type="button"
              disabled={!title.trim() || submitting}
              onClick={() => {
                void handleCreateAndDispatchCurrent();
              }}
            >
              {submitting ? "Creating..." : "Create & Dispatch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
