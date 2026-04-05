import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { matrixPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(matrixPlugin);
