import { Router } from "express";
import { sendCommand } from "../c4.js";
import { triggerPoll } from "../poller.js";

export const commandRouter = Router();

commandRouter.post("/command", async (req, res) => {
  const { deviceId, command, params } = req.body as {
    deviceId: number;
    command: string;
    params?: Record<string, string>;
  };

  if (!deviceId || !command) {
    res.status(400).json({ error: "deviceId and command are required" });
    return;
  }

  try {
    await sendCommand(deviceId, command, params);
    // Trigger an immediate state refresh so SSE clients see the change quickly
    triggerPoll().catch((err) => console.error("[command] triggerPoll error:", err));
    res.json({ ok: true });
  } catch (err) {
    console.error("[command] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
