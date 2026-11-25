import { it } from "vitest";
import { workboardTestConfig } from "./database-config.js";

// File/catalog and native-statement contracts do not apply to the experimental engine.
export const sqliteOnly = it.skipIf(workboardTestConfig().database?.engine === "postgres");
