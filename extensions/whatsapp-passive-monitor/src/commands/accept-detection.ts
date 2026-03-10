import type { Command } from "../interfaces/command.ts";
import type { DetectionRepository } from "../repository/detection-repository.ts";
import type { Logger } from "../types.ts";

export type AcceptDetectionDeps = {
  detectionRepo: DetectionRepository;
  logger: Logger;
};

export type AcceptDetectionCtx = {
  detectionId: number;
};

export type AcceptDetectionResult = {
  accepted: boolean;
};

// Marks a detection as created — called by the agent skill after
// a calendar event has been successfully created.
export const acceptDetection: Command<
  AcceptDetectionDeps,
  AcceptDetectionCtx,
  AcceptDetectionResult
> = (deps) => {
  const { detectionRepo, logger } = deps;

  return async (ctx) => {
    detectionRepo.markCreated(ctx.detectionId);
    logger.info(`accept-detection: marked detection ${ctx.detectionId} as created`);
    return { accepted: true };
  };
};
