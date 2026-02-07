"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/composed/ConfirmDialog";
import { cn } from "@/lib/utils";
import {
  cancelAutomation,
  createAutomation,
  deleteAutomation,
  getAutomationHistory,
  listAutomations,
  runAutomation,
  updateAutomation,
  type Automation,
  type AutomationRunRecord,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationType,
} from "@/lib/api";
import { CalendarClock, Play, RefreshCw, Trash2 } from "lucide-react";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/automations/")({
  component: AutomationsPage,
  errorComponent: RouteErrorFallback,
});

type StatusFilter = "all" | AutomationStatus;

type ScheduleFormState = {
  scheduleType: "at" | "every" | "cron";
  scheduleAt: string;
  scheduleEveryAmount: string;
  scheduleEveryUnit: "minutes" | "hours" | "days";
  scheduleCronExpr: string;
  scheduleCronTz: string;
};

type AutomationFormState = {
  name: string;
  description: string;
  type: AutomationType;
  configJson: string;
} & ScheduleFormState;

const statusFilters: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "error", label: "Error" },
];

const automationTypes: { value: AutomationType; label: string }[] = [
  { value: "smart-sync-fork", label: "Smart Sync Fork" },
  { value: "custom-script", label: "Custom Script" },
  { value: "webhook", label: "Webhook" },
];

const scheduleTypeLabels: Record<ScheduleFormState["scheduleType"], string> = {
  at: "Run At",
  every: "Run Every",
  cron: "Cron",
};

const scheduleUnitOptions: Array<ScheduleFormState["scheduleEveryUnit"]> = [
  "minutes",
  "hours",
  "days",
];

const emptyFormState: AutomationFormState = {
  name: "",
  description: "",
  type: "smart-sync-fork",
  configJson: "{}",
  scheduleType: "every",
  scheduleAt: "",
  scheduleEveryAmount: "1",
  scheduleEveryUnit: "hours",
  scheduleCronExpr: "",
  scheduleCronTz: "",
};

function AutomationsPage() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [selectedAutomationId, setSelectedAutomationId] = React.useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [formState, setFormState] = React.useState<AutomationFormState>(emptyFormState);
  const [deleteTarget, setDeleteTarget] = React.useState<Automation | null>(null);

  const automationsQuery = useQuery({
    queryKey: ["automations", "list"],
    queryFn: listAutomations,
  });

  const automations = automationsQuery.data?.automations ?? [];

  const historyQuery = useQuery({
    queryKey: ["automations", "history", selectedAutomationId],
    queryFn: () => getAutomationHistory(selectedAutomationId ?? "", 50),
    enabled: Boolean(selectedAutomationId),
  });

  const runMutation = useMutation({
    mutationFn: runAutomation,
    onSuccess: () => {
      toast.success("Automation started");
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void historyQuery.refetch();
    },
    onError: (error: Error) => {
      toast.error(`Failed to run automation: ${error.message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: updateAutomation,
    onSuccess: () => {
      toast.success("Automation updated");
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update automation: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAutomation,
    onSuccess: () => {
      toast.success("Automation deleted");
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      if (deleteTarget?.id === selectedAutomationId) {
        setSelectedAutomationId(null);
      }
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete automation: ${error.message}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: cancelAutomation,
    onSuccess: () => {
      toast.success("Automation cancelled");
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void historyQuery.refetch();
    },
    onError: (error: Error) => {
      toast.error(`Failed to cancel automation: ${error.message}`);
    },
  });

  const createMutation = useMutation({
    mutationFn: createAutomation,
    onSuccess: () => {
      toast.success("Automation created");
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      setIsCreateOpen(false);
      setFormState(emptyFormState);
    },
    onError: (error: Error) => {
      toast.error(`Failed to create automation: ${error.message}`);
    },
  });

  React.useEffect(() => {
    if (!selectedAutomationId && automations.length > 0) {
      setSelectedAutomationId(automations[0].id);
      return;
    }

    if (selectedAutomationId && !automations.find((automation) => automation.id === selectedAutomationId)) {
      setSelectedAutomationId(automations[0]?.id ?? null);
    }
  }, [automations, selectedAutomationId]);

  const filteredAutomations = React.useMemo(() => {
    return automations.filter((automation) => {
      if (statusFilter !== "all" && automation.status !== statusFilter) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      const query = searchQuery.toLowerCase();
      return (
        automation.name.toLowerCase().includes(query) ||
        (automation.description ?? "").toLowerCase().includes(query)
      );
    });
  }, [automations, searchQuery, statusFilter]);

  const selectedAutomation = React.useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId) ?? null,
    [automations, selectedAutomationId]
  );

  const historyRecords = historyQuery.data?.records ?? [];

  const handleToggleEnabled = (automation: Automation, enabled: boolean) => {
    updateMutation.mutate({ id: automation.id, enabled });
  };

  const handleRun = (automationId: string) => {
    runMutation.mutate(automationId);
  };

  const handleCancelRun = (record: AutomationRunRecord) => {
    cancelMutation.mutate(record.id);
  };

  const handleDeleteAutomation = () => {
    if (!deleteTarget) {return;}
    deleteMutation.mutate(deleteTarget.id);
  };

  const updateForm = <K extends keyof AutomationFormState>(key: K, value: AutomationFormState[K]) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const handleCreateAutomation = () => {
    if (!formState.name.trim()) {
      toast.error("Name is required");
      return;
    }

    let schedule: AutomationSchedule;

    if (formState.scheduleType === "at") {
      const parsed = Date.parse(formState.scheduleAt);
      if (!Number.isFinite(parsed)) {
        toast.error("Invalid run time");
        return;
      }
      schedule = { type: "at", atMs: parsed };
    } else if (formState.scheduleType === "every") {
      const amount = Number(formState.scheduleEveryAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error("Interval must be a positive number");
        return;
      }

      const multiplier =
        formState.scheduleEveryUnit === "minutes"
          ? 60_000
          : formState.scheduleEveryUnit === "hours"
            ? 3_600_000
            : 86_400_000;

      schedule = { type: "every", everyMs: amount * multiplier };
    } else {
      const expr = formState.scheduleCronExpr.trim();
      if (!expr) {
        toast.error("Cron expression is required");
        return;
      }
      schedule = {
        type: "cron",
        expr,
        tz: formState.scheduleCronTz.trim() || undefined,
      };
    }

    let config: Record<string, unknown> | undefined;
    if (formState.configJson.trim()) {
      try {
        config = JSON.parse(formState.configJson) as Record<string, unknown>;
      } catch {
        toast.error("Config JSON is invalid");
        return;
      }
    }

    createMutation.mutate({
      name: formState.name.trim(),
      description: formState.description.trim() || undefined,
      type: formState.type,
      schedule,
      enabled: true,
      config,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <CalendarClock className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Automations</h1>
            <p className="text-sm text-muted-foreground">
              {automations.length} automation{automations.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <Button className="gap-2" onClick={() => setIsCreateOpen(true)}>
          <span>Create automation</span>
        </Button>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
          <Input
            placeholder="Search automations..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="md:max-w-sm"
          />
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger className="md:w-48">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              {statusFilters.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>
                  {filter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => void automationsQuery.refetch()}
          disabled={automationsQuery.isFetching}
        >
          <RefreshCw className={cn("h-4 w-4", automationsQuery.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {automationsQuery.isLoading && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Card key={index} className="p-4">
                  <Skeleton className="h-6 w-1/3" />
                  <Skeleton className="mt-2 h-4 w-2/3" />
                  <Skeleton className="mt-4 h-8 w-full" />
                </Card>
              ))}
            </div>
          )}

          {!automationsQuery.isLoading && filteredAutomations.length === 0 && (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              No automations match your filters.
            </Card>
          )}

          {filteredAutomations.map((automation) => (
            <Card
              key={automation.id}
              className={cn(
                "p-4 transition",
                selectedAutomationId === automation.id && "border-primary/60 shadow-sm"
              )}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-foreground">{automation.name}</h2>
                    <Badge variant={statusVariant(automation.status)}>{automation.status}</Badge>
                    <Badge variant="secondary">{automation.type}</Badge>
                  </div>
                  {automation.description && (
                    <p className="text-sm text-muted-foreground">{automation.description}</p>
                  )}
                  <div className="text-xs text-muted-foreground">
                    <div>Schedule: {formatSchedule(automation.schedule)}</div>
                    <div>Next run: {formatTimestamp(automation.nextRunAt)}</div>
                    <div>
                      Last run: {automation.lastRun ? formatTimestamp(automation.lastRun.at) : "—"}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs">
                    <span className="text-muted-foreground">Enabled</span>
                    <Switch
                      checked={automation.enabled}
                      onCheckedChange={(checked) => handleToggleEnabled(automation, checked)}
                      disabled={updateMutation.isPending}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => setSelectedAutomationId(automation.id)}
                  >
                    View runs
                  </Button>
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={() => handleRun(automation.id)}
                    disabled={runMutation.isPending}
                  >
                    <Play className="h-4 w-4" />
                    Run
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-2"
                    onClick={() => setDeleteTarget(automation)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <Card className="h-fit p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Run history</h3>
              <p className="text-xs text-muted-foreground">
                {selectedAutomation?.name ?? "Select an automation"}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void historyQuery.refetch()}
              disabled={!selectedAutomationId || historyQuery.isFetching}
            >
              <RefreshCw className={cn("h-4 w-4", historyQuery.isFetching && "animate-spin")} />
            </Button>
          </div>

          {!selectedAutomationId && (
            <div className="mt-4 text-sm text-muted-foreground">Choose an automation to view its runs.</div>
          )}

          {historyQuery.isLoading && selectedAutomationId && (
            <div className="mt-4 space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          )}

          {!historyQuery.isLoading && selectedAutomationId && historyRecords.length === 0 && (
            <div className="mt-4 text-sm text-muted-foreground">No runs recorded yet.</div>
          )}

          <div className="mt-4 space-y-3">
            {historyRecords.map((record) => (
              <div key={record.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-foreground">{record.automationName}</div>
                    <div className="text-xs text-muted-foreground">
                      Started: {formatTimestamp(record.startedAt)}
                    </div>
                  </div>
                  <Badge variant={runStatusVariant(record.status)}>{record.status}</Badge>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {record.summary || record.error || "No summary"}
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Duration: {record.durationMs ? formatDuration(record.durationMs) : "—"}</span>
                  {record.status === "running" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCancelRun(record)}
                      disabled={cancelMutation.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create automation</DialogTitle>
            <DialogDescription>Define the schedule and payload for a new automation.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="automation-name">Name</Label>
              <Input
                id="automation-name"
                value={formState.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="Weekly metrics sync"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="automation-description">Description</Label>
              <Textarea
                id="automation-description"
                value={formState.description}
                onChange={(event) => updateForm("description", event.target.value)}
                placeholder="Optional description"
                rows={2}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={formState.type}
                  onValueChange={(value) => updateForm("type", value as AutomationType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {automationTypes.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Schedule type</Label>
                <Select
                  value={formState.scheduleType}
                  onValueChange={(value) =>
                    updateForm("scheduleType", value as ScheduleFormState["scheduleType"])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(scheduleTypeLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {formState.scheduleType === "at" && (
              <div className="space-y-2">
                <Label>Run at</Label>
                <Input
                  type="datetime-local"
                  value={formState.scheduleAt}
                  onChange={(event) => updateForm("scheduleAt", event.target.value)}
                />
              </div>
            )}

            {formState.scheduleType === "every" && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Every</Label>
                  <Input
                    type="number"
                    min={1}
                    value={formState.scheduleEveryAmount}
                    onChange={(event) => updateForm("scheduleEveryAmount", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Unit</Label>
                  <Select
                    value={formState.scheduleEveryUnit}
                    onValueChange={(value) =>
                      updateForm("scheduleEveryUnit", value as ScheduleFormState["scheduleEveryUnit"])
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scheduleUnitOptions.map((unit) => (
                        <SelectItem key={unit} value={unit}>
                          {unit}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {formState.scheduleType === "cron" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Cron expression</Label>
                  <Input
                    value={formState.scheduleCronExpr}
                    onChange={(event) => updateForm("scheduleCronExpr", event.target.value)}
                    placeholder="0 9 * * 1"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Timezone (optional)</Label>
                  <Input
                    value={formState.scheduleCronTz}
                    onChange={(event) => updateForm("scheduleCronTz", event.target.value)}
                    placeholder="UTC"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Config JSON</Label>
              <Textarea
                value={formState.configJson}
                onChange={(event) => updateForm("configJson", event.target.value)}
                rows={4}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateAutomation} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete automation"
        description={`Delete automation "${deleteTarget?.name ?? ""}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDeleteAutomation}
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}

function formatTimestamp(value?: number): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1000)}s`;
  }
  if (durationMs < 3_600_000) {
    return `${Math.round(durationMs / 60_000)}m`;
  }
  if (durationMs < 86_400_000) {
    return `${Math.round(durationMs / 3_600_000)}h`;
  }
  return `${Math.round(durationMs / 86_400_000)}d`;
}

function formatSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === "at") {
    return schedule.atMs ? `At ${formatTimestamp(schedule.atMs)}` : "At —";
  }
  if (schedule.type === "every") {
    return schedule.everyMs ? `Every ${formatDuration(schedule.everyMs)}` : "Every —";
  }
  const tz = schedule.tz ? ` (${schedule.tz})` : "";
  return `Cron ${schedule.expr ?? ""}${tz}`;
}

function statusVariant(status: AutomationStatus): "success" | "warning" | "error" {
  if (status === "active") {
    return "success";
  }
  if (status === "suspended") {
    return "warning";
  }
  return "error";
}

function runStatusVariant(
  status: AutomationRunRecord["status"]
): "success" | "warning" | "error" | "secondary" {
  if (status === "success") {
    return "success";
  }
  if (status === "running") {
    return "warning";
  }
  if (status === "failed") {
    return "error";
  }
  return "secondary";
}
