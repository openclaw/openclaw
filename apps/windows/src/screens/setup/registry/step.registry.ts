import { StepDefinition } from "./step.types";

// Maps state-machine keys to existing setup routes.
export const stepRegistry: Record<string, StepDefinition> = {
  welcome: {
    id: "welcome",
    route: "/setup/welcome",
  },
  connect: {
    id: "connect",
    route: "/setup/connect",
  },
  mode: {
    id: "mode",
    route: "/setup/install-mode",
  },
  "install.progress": {
    id: "installProgress",
    route: "/setup/install",
  },
  "configure.onboard": {
    id: "onboard",
    route: "/setup/onboard",
  },
  "configure.connecting": {
    id: "connecting",
    route: "/setup/connecting",
  },
};

export const getStepByState = (
  stateValue: string | Record<string, string>
): StepDefinition | undefined => {
  if (typeof stateValue === "string") {
    return stepRegistry[stateValue];
  }
  if (typeof stateValue === "object") {
    const key = Object.keys(stateValue)[0];
    const val = stateValue[key];
    // Prefer "parent.child" match when nested states are present.
    if (stepRegistry[`${key}.${val}`]) return stepRegistry[`${key}.${val}`];
    // Fall back to parent state route if child route is not registered.
    return stepRegistry[key];
  }
  return undefined;
};
