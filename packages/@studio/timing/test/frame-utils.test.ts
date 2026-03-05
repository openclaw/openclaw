import { describe, it, expect } from "vitest";
import {
  secondsToFrames,
  framesToSeconds,
  msToFrame,
  frameToMs,
  clampFrame,
  getProgress,
} from "../src/frame-utils";

describe("frame-utils", () => {
  describe("secondsToFrames", () => {
    it("should convert seconds to frames correctly", () => {
      expect(secondsToFrames(1, 30)).toBe(30);
      expect(secondsToFrames(2.5, 30)).toBe(75);
      expect(secondsToFrames(0, 30)).toBe(0);
    });
  });

  describe("framesToSeconds", () => {
    it("should convert frames to seconds correctly", () => {
      expect(framesToSeconds(30, 30)).toBe(1);
      expect(framesToSeconds(75, 30)).toBe(2.5);
      expect(framesToSeconds(0, 30)).toBe(0);
    });
  });

  describe("msToFrame", () => {
    it("should convert milliseconds to frames correctly", () => {
      expect(msToFrame(1000, 30)).toBe(30);
      expect(msToFrame(500, 30)).toBe(15);
    });
  });

  describe("frameToMs", () => {
    it("should convert frames to milliseconds correctly", () => {
      expect(frameToMs(30, 30)).toBe(1000);
      expect(frameToMs(15, 30)).toBe(500);
    });
  });

  describe("clampFrame", () => {
    it("should clamp frame within range", () => {
      expect(clampFrame(50, 0, 100)).toBe(50);
      expect(clampFrame(-10, 0, 100)).toBe(0);
      expect(clampFrame(150, 0, 100)).toBe(100);
    });
  });

  describe("getProgress", () => {
    it("should calculate progress correctly", () => {
      expect(getProgress(0, 0, 100)).toBe(0);
      expect(getProgress(50, 0, 100)).toBe(0.5);
      expect(getProgress(100, 0, 100)).toBe(1);
      expect(getProgress(-10, 0, 100)).toBe(0);
      expect(getProgress(150, 0, 100)).toBe(1);
    });
  });
});
