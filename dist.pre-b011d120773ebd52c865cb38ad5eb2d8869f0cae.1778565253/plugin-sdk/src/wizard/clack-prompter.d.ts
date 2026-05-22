import { type Option } from "@clack/prompts";
import type { WizardPrompter } from "./prompts.js";
export declare function tokenizedOptionFilter<T>(search: string, option: Option<T>): boolean;
export declare function createClackPrompter(): WizardPrompter;
