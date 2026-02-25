"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  installSkill,
  removeSkill,
  deployConfig,
  restartTeam,
} from "@/lib/api";
import { useMutation } from "@tanstack/react-query";

interface MultiSelectActionsProps {
  selectedTeams: string[];
  onClear: () => void;
}

export function MultiSelectActions({ selectedTeams, onClear }: MultiSelectActionsProps) {
  const [action, setAction] = useState<string>("");
  const [progress, setProgress] = useState<Record<string, "pending" | "success" | "error">>({});

  const executeAction = async () => {
    if (!action) return;

    const newProgress: Record<string, "pending" | "success" | "error"> = {};
    selectedTeams.forEach((team) => {
      newProgress[team] = "pending";
    });
    setProgress(newProgress);

    const promises = selectedTeams.map(async (team) => {
      try {
        switch (action) {
          case "restart":
            await restartTeam(team);
            break;
          case "install-skill":
            const skill = prompt("Skill-Name:");
            if (skill) await installSkill(team, skill);
            break;
          case "remove-skill":
            const skillToRemove = prompt("Skill-Name:");
            if (skillToRemove) await removeSkill(team, skillToRemove);
            break;
        }
        newProgress[team] = "success";
      } catch (error) {
        newProgress[team] = "error";
      } finally {
        setProgress({ ...newProgress });
      }
    });

    await Promise.allSettled(promises);
  };

  const successCount = Object.values(progress).filter((p) => p === "success").length;
  const totalCount = selectedTeams.length;

  return (
    <div className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">
            {selectedTeams.length} Team(s) ausgewählt
          </span>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Aktion wählen" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="restart">Restart</SelectItem>
              <SelectItem value="install-skill">Skill installieren</SelectItem>
              <SelectItem value="remove-skill">Skill entfernen</SelectItem>
              <SelectItem value="deploy-config">Config deployen</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={executeAction} disabled={!action || totalCount === successCount}>
            Ausführen
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Auswahl löschen
        </Button>
      </div>
      {totalCount > 0 && (
        <div className="mt-4">
          <Progress value={(successCount / totalCount) * 100} className="h-2" />
          <div className="mt-2 text-xs text-gray-500">
            {successCount}/{totalCount} abgeschlossen
          </div>
        </div>
      )}
    </div>
  );
}
