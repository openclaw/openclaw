import { describe, it, expect, vi } from "vitest";
import type { DetectionRepository } from "../../repository/detection-repository.ts";
import type { Logger } from "../../types.ts";
import { acceptDetection } from "../accept-detection.ts";

const createMockDetectionRepo = (): DetectionRepository => ({
  insertDetection: vi.fn(),
  getLastDetection: vi.fn(),
  markCreated: vi.fn(),
  deleteDetection: vi.fn(),
});

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("acceptDetection", () => {
  it("calls markCreated with the detection id", async () => {
    const detectionRepo = createMockDetectionRepo();
    const logger = createMockLogger();
    const execute = acceptDetection({ detectionRepo, logger });

    await execute({ detectionId: 42 });

    expect(detectionRepo.markCreated).toHaveBeenCalledWith(42);
  });

  it("returns { accepted: true }", async () => {
    const execute = acceptDetection({
      detectionRepo: createMockDetectionRepo(),
      logger: createMockLogger(),
    });

    const result = await execute({ detectionId: 42 });

    expect(result).toEqual({ accepted: true });
  });

  it("logs the acceptance", async () => {
    const logger = createMockLogger();
    const execute = acceptDetection({
      detectionRepo: createMockDetectionRepo(),
      logger,
    });

    await execute({ detectionId: 42 });

    expect(logger.info).toHaveBeenCalled();
  });
});
