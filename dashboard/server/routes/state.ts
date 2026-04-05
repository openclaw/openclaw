import { Router } from "express";
import { getCurrentState } from "../poller.js";

export const stateRouter = Router();

stateRouter.get("/state", (_req, res) => {
  const state = getCurrentState();
  if (!state) {
    res.status(503).json({ error: "State not yet available — startup in progress" });
    return;
  }
  res.json(state);
});
