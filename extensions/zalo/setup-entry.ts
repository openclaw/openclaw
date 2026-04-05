import { defineSetupPluginEntry } from "mullusi/plugin-sdk/core";
import { zaloPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(zaloPlugin);
