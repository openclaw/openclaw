/**
 * Content Pipeline plugin entry point.
 *
 * This extension provides automated content creation pipelines
 * (tech news + tutorials) with video generation and social media upload.
 *
 * Run standalone: npx tsx src/cli.ts --help
 */

export { runPipeline, loadConfig } from "./src/pipeline.js";
export type { RunOptions, Stage } from "./src/pipeline.js";
export type { PipelineConfig, VideoContent, Article } from "./src/types.js";
