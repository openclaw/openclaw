import {
  Body1,
  Caption1,
  Card,
  makeStyles,
  Spinner,
  tokens,
} from "@fluentui/react-components";
import { useSetup } from "../context";
import {
  CheckmarkCircle20Filled,
  Clock20Filled,
  Warning20Filled,
} from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { InstallStep } from "../../../types/installer";
import { useWSLInstaller } from "../installers/wsl";
import { useOpenClawInstaller } from "../installers/openclaw";
import { SetupLayout } from "../layout";

import { useMachine } from "@xstate/react";
import { installMachine } from "../engine/install.machine";

export const SetupInstall = () => {
  const styles = useStyles();
  const { installData, changeMode, navigateBack } = useSetup();

  const [state, send] = useMachine(installMachine, {
    input: {
      installMode: (installData.installMode || "wsl") as "wsl" | "windows",
      wslDistro: installData.wslDistro ?? undefined,
    },
  });

  const { steps } = state.context;

  const updateInstallSteps = (key: string, data: Partial<InstallStep>) => {
    if (data.status === "installing") send({ type: "STEP_START", key });
    else if (data.status === "installed")
      send({ type: "STEP_SUCCESS", key, subText: data.subText });
    else if (data.status === "failed")
      send({ type: "STEP_FAILURE", key, error: data.error || "Unknown error" });
  };

  const wslInstaller = useWSLInstaller(updateInstallSteps);
  const openClawInstaller = useOpenClawInstaller(updateInstallSteps);

  const processors = useRef<
    Record<string, (key: string) => void | Promise<void>>
  >({
    wsl: wslInstaller.install,
    system: openClawInstaller.install,
    openclaw: openClawInstaller.install,
    doctor: openClawInstaller.install,
  });

  const [isChecking, setIsChecking] = useState(false);
  const [checksDone, setChecksDone] = useState(false);

  // After WSL is installed, run idempotent backend checks once before continuing.
  useEffect(() => {
    const wslStep = steps.find((s) => s.key === "wsl");
    if (wslStep?.status === "installed" && !checksDone && !isChecking) {
      const runChecks = async () => {
        setIsChecking(true);
        try {
          const systemOk = await openClawInstaller.check("system");
          if (systemOk) {
            const openclawOk = await openClawInstaller.check("openclaw");
            if (openclawOk) {
              await openClawInstaller.check("doctor");
            }
          }
        } finally {
          setChecksDone(true);
          setIsChecking(false);
          send({ type: "START" });
        }
      };
      runChecks();
    } else if (wslStep?.status === "pending" && state.matches("idle")) {
      send({ type: "START" });
    }
  }, [
    steps,
    checksDone,
    isChecking,
    state,
    send,
    openClawInstaller,
    wslInstaller,
  ]);

  useEffect(() => {
    if (!state.matches("processing")) return;

    const filteredSteps = steps.filter(
      (step) => step.mode === installData.installMode || !step.mode
    );

    const wslStep = filteredSteps.find((s) => s.key === "wsl");
    const wslReady = wslStep?.status === "installed";

    if (wslReady && (!checksDone || isChecking)) {
      return;
    }

    const isAnyInstalling = steps.some((s) => s.status === "installing");
    const nextStep = filteredSteps.find((s) => s.status === "pending");

    if (nextStep && !isAnyInstalling) {
      const run = async () => {
        try {
          await processors.current[nextStep.key]?.(nextStep.key);
        } catch (error) {
          send({
            type: "STEP_FAILURE",
            key: nextStep.key,
            error: String(error),
          });
        }
      };
      run();
    }
  }, [
    steps,
    state,
    installData.installMode,
    checksDone,
    isChecking,
    send,
    openClawInstaller,
    wslInstaller,
  ]);

  const safeAbort = async () => {
    await wslInstaller.abort();
    await openClawInstaller.abort();
  };

  return (
    <SetupLayout
      title="Installing OpenClaw"
      description="Please wait while we set things up"
      nextBtnDisabled={!state.matches("completed")}
      onNext={() => changeMode("config")}
      onBack={async () => {
        await safeAbort();
        navigateBack();
      }}
    >
      <Card className={styles.container}>
        <div className={styles.gatewayList}>
          {steps
            .filter(
              (step: InstallStep) =>
                step.mode === installData.installMode || !step.mode
            )
            .map((step: InstallStep) => (
              <Card
                key={step.key}
                appearance="subtle"
                style={{ height: "auto", minHeight: "fit-content" }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    gap: 10,
                    alignItems: "flex-start",
                    padding: "4px 0",
                  }}
                >
                  {step.status === "installed" ? (
                    <CheckmarkCircle20Filled
                      color={tokens.colorStatusSuccessForeground1}
                    />
                  ) : step.status === "failed" ? (
                    <Warning20Filled
                      color={tokens.colorStatusWarningForeground1}
                    />
                  ) : step.status === "pending" ? (
                    <Clock20Filled
                      color={tokens.colorStatusWarningForeground1}
                    />
                  ) : (
                    <Spinner size="tiny" />
                  )}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                      width: "100%",
                    }}
                  >
                    <Body1>{step.title}</Body1>
                    {step.subText && (
                      <Caption1
                        style={{ color: tokens.colorNeutralForeground3 }}
                      >
                        {step.subText}
                      </Caption1>
                    )}
                    {step.status === "failed" && step.error && (
                      <Caption1
                        style={{ color: tokens.colorStatusWarningForeground1 }}
                      >
                        {step.error}
                      </Caption1>
                    )}
                  </div>
                </div>
              </Card>
            ))}
        </div>
      </Card>
    </SetupLayout>
  );
};

const useStyles = makeStyles({
  container: {
    marginTop: "20px",
    width: "80%",
    borderRadius: tokens.borderRadiusXLarge,
    padding: "0px",
    maxHeight: "40vh",
    position: "relative",
    overflow: "hidden",
  },
  gatewayList: {
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    maxHeight: "calc(40vh - 40px)",
    padding: "4px",
  },
  progress: {
    width: "100%",
  },
});
