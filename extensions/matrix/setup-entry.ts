import { defineSetupPluginEntry } from "mullusi/plugin-sdk/core";
import { matrixPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(matrixPlugin);
