import { useMachine } from "@xstate/react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import { setupMachine } from "./engine/flow.machine";
import { loadState, saveState } from "./engine/persistence";
import { SetupEvent } from "./engine/flow.types";
import { getStepByState, stepRegistry } from "./registry/step.registry";
import { StepDefinition } from "./registry/step.types";
import { useNavigate, useLocation } from "react-router";
import { invoke } from "@tauri-apps/api/core";

interface SetupContextType {
  activePage: number;
  currentPage: StepDefinition | undefined;
  pages: StepDefinition[];
  isLoading: string;
  send: (event: SetupEvent) => void;
  navigateNext: () => void;
  navigateBack: () => void;
  installData: {
    installMode: "windows" | "wsl" | null | undefined;
    wslDistro: string | null | undefined;
  };
  updateInstallData: (data: {
    installMode?: "windows" | "wsl";
    wslDistro?: string | null;
  }) => void;
  setInstallPath: (path: string) => void;
  // Public actions used across setup screens
  changeMode: (mode: string) => void;
}

const SetupStateContext = createContext<SetupContextType | undefined>(
  undefined
);

export const SetupProvider = ({ children }: { children: React.ReactNode }) => {
  const [initialState, setInitialState] = useState<unknown>(null);
  const [isRestoring, setIsRestoring] = useState(true);

  useEffect(() => {
    const restore = async () => {
      const persisted = await loadState();
      if (persisted) {
        setInitialState(persisted);
      }
      setIsRestoring(false);
    };
    restore();
  }, []);

  if (isRestoring) {
    return null; // Wait for persisted setup state before rendering.
  }

  return (
    <SetupProviderInner initialState={initialState}>
      {children}
    </SetupProviderInner>
  );
};

const SetupProviderInner = ({
  children,
  initialState,
}: {
  children: React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialState: any;
}) => {
  const [state, send, actor] = useMachine(setupMachine, {
    snapshot: initialState,
  });
  const navigate = useNavigate();
  const location = useLocation();

  // Logging for setup state transitions.
  useEffect(() => {
    console.log("[SetupProvider] State changed:", {
      value: state.value,
      context: state.context,
    });
  }, [state]);

  // Persist machine snapshot so setup can resume after restart.
  useEffect(() => {
    const sub = actor.subscribe((s) => {
      saveState(s);
    });
    return () => sub.unsubscribe();
  }, [actor]);

  const logicalOrder = [
    "welcome",
    "connect",
    "mode",
    "install.progress",
    "configure.onboard",
    "configure.connecting",
    "complete",
  ];

  const currentStepDef = getStepByState(
    state.value as string | Record<string, string>
  );
  const activePageIndex = logicalOrder.findIndex((k) => {
    // Exact match by ID or key first.
    if (currentStepDef?.id === stepRegistry[k]?.id) return true;
    if (k === currentStepDef?.id) return true;

    // Loose matching as fallback for general configure states not in registry.
    const isConfigureState =
      typeof state.value === "object" &&
      Object.keys(state.value)[0] === "configure";
    if (isConfigureState && k === "configure.onboard" && !currentStepDef)
      return true;

    return false;
  });

  const pages = logicalOrder.map((k) => stepRegistry[k]).filter(Boolean);

  // Keep route and state machine step in sync.
  useEffect(() => {
    if (state.matches("complete")) {
      invoke("mark_setup_completed");
      return;
    }

    if (currentStepDef) {
      console.log("[SetupProvider] Syncing route:", {
        path: location.pathname,
        target: currentStepDef.route,
        state: state.value,
      });
      if (location.pathname !== currentStepDef.route) {
        // Avoid navigating to the same route repeatedly.
        navigate(currentStepDef.route);
      }
    } else {
      console.log("[SetupProvider] No currentStepDef for state:", state.value);
    }
  }, [state, state.value, location.pathname, navigate, currentStepDef]);

  // Public navigation helpers.
  const navigateNext = useCallback(() => {
    console.log("[SetupProvider] navigateNext called, sending NEXT event");
    send({ type: "NEXT" });
  }, [send]);

  const navigateBack = useCallback(() => send({ type: "BACK" }), [send]);

  const updateInstallData = useCallback(
    (data: { installMode?: "windows" | "wsl"; wslDistro?: string | null }) => {
      if (data.installMode) {
        send({ type: "SET_INSTALL_MODE", installMode: data.installMode });
        // If the user picked an install mode, move from mode selection to install flow.
        if (actor.getSnapshot().matches("mode")) {
          send({ type: "SET_MODE", mode: "install" });
        }
      }
      if (typeof data.wslDistro === "string") {
        send({ type: "SET_WSL_DISTRO", distro: data.wslDistro });
      }
    },
    [actor, send]
  );

  const setInstallPath = useCallback(
    (path: string) => send({ type: "SET_INSTALL_PATH", path }),
    [send]
  );

  const changeMode = useCallback(
    (mode: string) => {
      // Older callers may still pass "config"; treat it as advance to configure.
      if (mode === "config") {
        // NEXT moves install.progress into configure.onboard.
        send({ type: "NEXT" });
      } else if (mode === "install") {
        send({ type: "SET_MODE", mode: "install" });
      }
    },
    [send]
  );

  const ctxValue = {
    activePage: activePageIndex === -1 ? 0 : activePageIndex,
    currentPage: currentStepDef,
    pages,
    isLoading: "idle",
    send,
    navigateNext,
    navigateBack,
    installData: {
      installMode: state.context.installMode,
      wslDistro: state.context.wslDistro,
    },
    updateInstallData,
    setInstallPath,
    changeMode,
  };

  return (
    <SetupStateContext.Provider value={ctxValue}>
      {children}
    </SetupStateContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useSetup = () => {
  const context = useContext(SetupStateContext);
  if (!context) {
    throw new Error("useSetup must be used within a SetupProvider");
  }
  return context;
};
