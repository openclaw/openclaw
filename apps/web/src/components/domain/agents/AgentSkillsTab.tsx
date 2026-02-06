"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CardSkeleton } from "@/components/composed";
import { useSkillsStatus, type SkillStatusEntry } from "@/hooks/queries/useSkills";
import { useConfig } from "@/hooks/queries/useConfig";
import { usePatchConfig } from "@/hooks/mutations/useConfigMutations";
import { useInstallSkill, useUninstallSkill } from "@/hooks/mutations/useSkillMutations";
import { buildAgentsPatch, getAgentsList, type AgentConfigEntry } from "@/lib/agents";

interface AgentSkillsTabProps {
  agentId: string;
}

type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

const SKILL_SOURCE_GROUPS: Array<{ id: string; label: string; sources: string[] }> = [
  { id: "workspace", label: "Workspace Skills", sources: ["openclaw-workspace"] },
  { id: "built-in", label: "Built-in Skills", sources: ["openclaw-bundled"] },
  { id: "installed", label: "Installed Skills", sources: ["openclaw-managed"] },
  { id: "extra", label: "Extra Skills", sources: ["openclaw-extra"] },
];

function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: "Other Skills", skills: [] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_SOURCE_GROUPS.map((group) => groups.get(group.id)).filter(
    (group): group is SkillGroup => Boolean(group && group.skills.length > 0)
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

function buildMissingSummary(skill: SkillStatusEntry) {
  const missing = [
    ...skill.missing.bins.map((value) => `bin:${value}`),
    ...skill.missing.anyBins.map((value) => `any:${value}`),
    ...skill.missing.env.map((value) => `env:${value}`),
    ...skill.missing.config.map((value) => `config:${value}`),
    ...skill.missing.os.map((value) => `os:${value}`),
  ];
  return missing.length > 0 ? missing.join(", ") : null;
}

export function AgentSkillsTab({ agentId }: AgentSkillsTabProps) {
  const [filter, setFilter] = React.useState("");
  const { data: report, isLoading, error, refetch, isFetching } = useSkillsStatus({ agentId });
  const { data: configSnapshot, isLoading: configLoading } = useConfig();
  const patchConfig = usePatchConfig();
  const installSkillMutation = useInstallSkill();
  const uninstallSkillMutation = useUninstallSkill();

  const agentsList = React.useMemo(
    () => getAgentsList(configSnapshot?.config),
    [configSnapshot?.config]
  );
  const agentEntry = React.useMemo<AgentConfigEntry | null>(
    () => agentsList.find((entry) => entry.id === agentId) ?? null,
    [agentsList, agentId]
  );
  const allowlist = agentEntry?.skills;
  const usingAllowlist = Array.isArray(allowlist);
  const allowSet = React.useMemo(
    () => new Set((allowlist ?? []).map((name) => name.trim()).filter(Boolean)),
    [allowlist]
  );

  const skills = report?.skills ?? [];
  const totalCount = skills.length;
  const enabledCount = usingAllowlist
    ? skills.filter((skill) => allowSet.has(skill.name)).length
    : totalCount;

  const filterValue = filter.trim().toLowerCase();
  const filteredSkills = filterValue
    ? skills.filter((skill) =>
        [skill.name, skill.description, skill.source].join(" ").toLowerCase().includes(filterValue)
      )
    : skills;
  const groups = groupSkills(filteredSkills);
  const allSkillNames = React.useMemo(
    () => Array.from(new Set(skills.map((skill) => skill.name))),
    [skills]
  );

  const canEdit = Boolean(configSnapshot?.hash && agentEntry) && !patchConfig.isPending;

  const updateAllowlist = (nextAllowlist: string[] | undefined) => {
    if (!configSnapshot?.hash || !agentEntry) {
      return;
    }
    const nextEntry = { ...agentEntry } as AgentConfigEntry & { skills?: string[] };
    if (nextAllowlist === undefined) {
      delete nextEntry.skills;
    } else {
      nextEntry.skills = nextAllowlist;
    }
    const nextList = agentsList.map((entry) =>
      entry.id === agentId ? nextEntry : entry
    );
    const patch = buildAgentsPatch(configSnapshot.config, nextList);
    patchConfig.mutate({
      baseHash: configSnapshot.hash,
      raw: JSON.stringify(patch),
      note: "Update agent skills",
    });
  };

  const handleToggle = (skillName: string, enabled: boolean) => {
    if (!allSkillNames.length) {
      return;
    }
    const baseAllowlist = usingAllowlist ? allowlist ?? [] : allSkillNames;
    const nextSet = new Set(baseAllowlist);
    if (enabled) {
      nextSet.add(skillName);
    } else {
      nextSet.delete(skillName);
    }
    const nextAllowlist = allSkillNames.filter((name) => nextSet.has(name));
    updateAllowlist(nextAllowlist.length === allSkillNames.length ? undefined : nextAllowlist);
  };

  const handleUseAll = () => {
    updateAllowlist(undefined);
  };

  const handleDisableAll = () => {
    updateAllowlist([]);
  };

  if (isLoading || configLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="p-6 text-center">
          <p className="text-destructive">Failed to load skills</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border-border/50">
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold">Skills</h3>
                <Badge variant="secondary" className="text-xs">
                  {enabledCount}/{totalCount}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Per-agent skill allowlist and workspace skills.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={handleUseAll} disabled={!canEdit}>
                Use All
              </Button>
              <Button size="sm" variant="outline" onClick={handleDisableAll} disabled={!canEdit}>
                Disable All
              </Button>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                {isFetching ? "Refreshing…" : "Refresh"}
              </Button>
            </div>
          </div>

          {!configSnapshot?.config && (
            <Alert>
              <AlertDescription>
                Load the gateway config to set per-agent skills.
              </AlertDescription>
            </Alert>
          )}
          {usingAllowlist ? (
            <Alert>
              <AlertDescription>
                This agent uses a custom skill allowlist.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertDescription>
                All skills are enabled. Disabling any skill will create a per-agent allowlist.
              </AlertDescription>
            </Alert>
          )}
          {!agentEntry && (
            <Alert>
              <AlertDescription>
                This agent is not listed in the gateway config yet. Add it to enable skill
                overrides.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search skills"
              />
            </div>
            <div className="text-sm text-muted-foreground">{filteredSkills.length} shown</div>
          </div>
        </CardContent>
      </Card>

      {filteredSkills.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <h3 className="text-lg font-medium">No skills found</h3>
            <p className="mt-1 text-sm text-muted-foreground text-center max-w-sm">
              Try adjusting the filter or reload the skills report.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <Card key={group.id} className="border-border/50">
              <CardContent className="pt-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-base font-semibold">{group.label}</h4>
                    <p className="text-xs text-muted-foreground">{group.skills.length} skills</p>
                  </div>
                </div>
                <div className="space-y-3">
                  {group.skills.map((skill) => {
                    const enabled = usingAllowlist ? allowSet.has(skill.name) : true;
                    const missing = buildMissingSummary(skill);
                    const installOption = skill.install[0];
                    const canInstall = Boolean(
                      installOption &&
                        !installOption.installed &&
                        skill.missing.bins.length > 0
                    );
                    const canUninstall = Boolean(
                      installOption?.installed && installOption?.uninstall
                    );
                    const skillActionPending =
                      installSkillMutation.isPending || uninstallSkillMutation.isPending;
                    const reasons = [
                      skill.disabled ? "disabled" : null,
                      skill.blockedByAllowlist ? "blocked by allowlist" : null,
                    ].filter(Boolean);
                    return (
                      <div
                        key={skill.skillKey}
                        className="flex flex-col gap-4 rounded-lg border border-border/50 p-4 md:flex-row md:items-start md:justify-between"
                      >
                        <div className="space-y-2">
                          <div className="text-sm font-semibold">
                            {skill.emoji ? `${skill.emoji} ` : ""}
                            {skill.name}
                          </div>
                          <p className="text-sm text-muted-foreground">{skill.description}</p>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="secondary" className="text-[10px]">
                              {skill.source}
                            </Badge>
                            <Badge
                              variant={skill.eligible ? "success" : "warning"}
                              className="text-[10px]"
                            >
                              {skill.eligible ? "eligible" : "blocked"}
                            </Badge>
                            {skill.disabled && (
                              <Badge variant="warning" className="text-[10px]">
                                disabled
                              </Badge>
                            )}
                          </div>
                          {missing && (
                            <p className="text-xs text-muted-foreground">Missing: {missing}</p>
                          )}
                          {reasons.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              Reason: {reasons.join(", ")}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-3">
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={enabled}
                              onCheckedChange={(next) => handleToggle(skill.name, next)}
                              disabled={!canEdit}
                            />
                            <span className="text-xs text-muted-foreground">
                              {enabled ? "Enabled" : "Disabled"}
                            </span>
                          </div>
                          {(canInstall || canUninstall) && (
                            <div className="flex flex-wrap justify-end gap-2">
                              {canInstall && installOption && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={skillActionPending}
                                  onClick={() => {
                                    installSkillMutation.mutate(
                                      {
                                        name: skill.name,
                                        installId: installOption.id,
                                        timeoutMs: 120000,
                                      },
                                      {
                                        onSettled: () => {
                                          void refetch();
                                        },
                                      }
                                    );
                                  }}
                                >
                                  {installSkillMutation.isPending
                                    ? "Installing…"
                                    : installOption.label}
                                </Button>
                              )}
                              {canUninstall && installOption?.uninstall && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={skillActionPending}
                                  onClick={() => {
                                    uninstallSkillMutation.mutate(
                                      {
                                        name: skill.name,
                                        installId: installOption.id,
                                        timeoutMs: 120000,
                                      },
                                      {
                                        onSettled: () => {
                                          void refetch();
                                        },
                                      }
                                    );
                                  }}
                                >
                                  {uninstallSkillMutation.isPending
                                    ? "Uninstalling…"
                                    : installOption.uninstall.label}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default AgentSkillsTab;
