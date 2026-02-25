"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { installSkill, removeSkill } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface SkillManagementProps {
  subdomain: string;
}

const AVAILABLE_SKILLS = [
  "google-sheets",
  "webapp-testing",
  "agent-config",
  "api-gateway-patterns",
  "api-security-hardening",
  "find-skills",
  "git-guardrails-claude-code",
  "honesty",
  "hooks-configuration",
  "langfuse-observability",
  "langsmith-observability",
  "llm-app-patterns",
  "managed-config",
  "meta-prompt-engineering",
  "nemo-guardrails",
  "optimize-agents-md",
  "owasp-security-check",
  "portkey-python-sdk",
  "research",
];

export function SkillManagement({ subdomain }: SkillManagementProps) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const installMutation = useMutation({
    mutationFn: (skill: string) => installSkill(subdomain, skill),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health"] });
      setOpen(false);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (skill: string) => removeSkill(subdomain, skill),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health"] });
    },
  });

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-gray-500">Skills</div>
      <div className="flex gap-2">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              Skill installieren
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Skill installieren</DialogTitle>
              <DialogDescription>
                Wähle einen Skill aus, der für {subdomain} installiert werden soll.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-60 overflow-y-auto space-y-2">
              {AVAILABLE_SKILLS.map((skill) => (
                <Button
                  key={skill}
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => installMutation.mutate(skill)}
                  disabled={installMutation.isPending}
                >
                  {skill}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => {
            const skill = prompt("Skill-Name zum Entfernen:");
            if (skill) {
              if (confirm(`Skill "${skill}" wirklich entfernen?`)) {
                removeMutation.mutate(skill);
              }
            }
          }}
          disabled={removeMutation.isPending}
        >
          Skill entfernen
        </Button>
      </div>
    </div>
  );
}
