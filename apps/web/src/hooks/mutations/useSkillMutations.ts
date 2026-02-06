/**
 * React Query mutation hooks for skills operations.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  updateSkill,
  enableSkill,
  disableSkill,
  installSkill,
  uninstallSkill,
  type SkillUpdateParams,
  type SkillInstallParams,
  type SkillUninstallParams,
} from "@/lib/api/skills";
import { skillKeys } from "@/hooks/queries/useSkills";

/**
 * Hook to update a skill's configuration
 */
export function useUpdateSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: SkillUpdateParams) => updateSkill(params),
    onSuccess: (_, params) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.detail(params.skillKey) });
      void queryClient.invalidateQueries({ queryKey: skillKeys.status() });
      toast.success(`Skill "${params.skillKey}" updated`);
    },
    onError: (error) => {
      console.error("[useUpdateSkill] Failed:", error);
      toast.error("Failed to update skill");
    },
  });
}

/**
 * Hook to enable a skill
 */
export function useEnableSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (skillKey: string) => enableSkill(skillKey),
    onSuccess: (_, skillKey) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.detail(skillKey) });
      void queryClient.invalidateQueries({ queryKey: skillKeys.status() });
      toast.success(`Skill "${skillKey}" enabled`);
    },
    onError: (error) => {
      console.error("[useEnableSkill] Failed:", error);
      toast.error("Failed to enable skill");
    },
  });
}

/**
 * Hook to disable a skill
 */
export function useDisableSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (skillKey: string) => disableSkill(skillKey),
    onSuccess: (_, skillKey) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.detail(skillKey) });
      void queryClient.invalidateQueries({ queryKey: skillKeys.status() });
      toast.success(`Skill "${skillKey}" disabled`);
    },
    onError: (error) => {
      console.error("[useDisableSkill] Failed:", error);
      toast.error("Failed to disable skill");
    },
  });
}

/**
 * Hook to install a new skill
 * Note: This operation can take up to 120 seconds
 */
export function useInstallSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: SkillInstallParams) => installSkill(params),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.status() });
      if (result.ok) {
        toast.success("Skill installation completed");
      } else {
        toast.info(result.message ?? "Skill installation completed");
      }
    },
    onError: (error) => {
      console.error("[useInstallSkill] Failed:", error);
      toast.error("Failed to install skill");
    },
  });
}

/**
 * Hook to uninstall an installed skill dependency
 */
export function useUninstallSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: SkillUninstallParams) => uninstallSkill(params),
    onSuccess: (result, params) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.status() });
      if (result.ok) {
        toast.success(`Skill "${params.name}" uninstall completed`);
      } else {
        toast.info(result.message ?? "Skill uninstall completed");
      }
    },
    onError: (error) => {
      console.error("[useUninstallSkill] Failed:", error);
      toast.error("Failed to uninstall skill");
    },
  });
}

// Re-export types
export type { SkillUpdateParams, SkillInstallParams, SkillUninstallParams };
