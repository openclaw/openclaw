import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { matrixPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(matrixPlugin);
