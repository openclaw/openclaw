import {
  Button,
  Caption1,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Divider,
  Field,
  Input,
  makeStyles,
  Spinner,
  Tab,
  TabList,
  tokens,
  ProgressBar,
} from "@fluentui/react-components";
import { SubmitEventHandler, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { DiscoveredGateway, SSHConfig } from "../../../types/gateway";
import { Folder20Regular, RouterFilled } from "@fluentui/react-icons";
import { useGateway } from "../../../gateway";
import { open } from "@tauri-apps/plugin-dialog";
import { GatewayItem } from "./partials/gateway-item";
import { ErrorBanner } from "../partials/ErrorBanner";
import { useSetup } from "../context";

import { SetupLayout } from "../layout";

export default function SetupConnectPage() {
  const styles = useStyles();
  const { changeMode, navigateNext } = useSetup();
  const gatewayStatus = useGateway();
  const [gateways, setGateways] = useState<DiscoveredGateway[]>([]);
  const [askTokenDialog, setAskTokenDialog] = useState(false);
  const [selectedGateway, setSelectedGateway] = useState<
    (DiscoveredGateway & Partial<SSHConfig>) | null
  >(null);
  const [markingSetupCompleted, setMarkingSetupCompleted] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn;
    let stopTimer: ReturnType<typeof setTimeout>;

    async function init() {
      setIsSearching(true);
      unlisten = await listen<DiscoveredGateway>("gateway_found", (event) => {
        setGateways((prev) => {
          const isAlreadyPresent = prev.some(
            (gateway) => gateway.address === event.payload.address
          );
          if (isAlreadyPresent) {
            return prev;
          }
          return [
            ...prev,
            {
              ...event.payload,
              fullname: event.payload.fullname.replace(
                "._openclaw-gw._tcp.local.",
                ""
              ),
            },
          ];
        });
      });

      await invoke("start_discovery");
      // Discovery is time-bounded to avoid an indefinitely running mDNS scan.
      stopTimer = setTimeout(() => {
        setIsSearching(false);
        invoke("stop_discovery");
      }, 30_000);
    }

    init();

    return () => {
      clearTimeout(stopTimer);
      if (unlisten) unlisten();
      invoke("stop_discovery");
    };
  }, []);

  const handleNext = async () => {
    await invoke("mark_setup_completed");
    navigateNext();
  };

  const [tokenSource, setTokenSource] = useState<"manual" | "ssh">("manual");
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [isFetchingToken, setIsFetchingToken] = useState(false);
  const [tokenError, setTokenError] = useState("");

  const fetchTokenFromSSH = async () => {
    setIsFetchingToken(true);
    setTokenError("");
    try {
      const method = {
        type: "ssh",
        host: selectedGateway?.address,
        user: selectedGateway?.user,
        port: Number(selectedGateway?.port),
        key_path: keyPath,
      };

      const token = await invoke<string>("get_gateway_token", { method });
      if (token) {
        setAskTokenDialog(false);
        await invoke("connect_gateway", {
          address: selectedGateway?.address,
          port: selectedGateway?.port,
          token,
          gatewayType: selectedGateway?.type,
          gatewayMode:
            selectedGateway?.type === "remote" ? "remote-direct" : "local",
          remoteUrl:
            selectedGateway?.type === "remote"
              ? `ws://${selectedGateway?.address}:${selectedGateway?.port}`
              : null,
          sshUser: selectedGateway?.user,
          sshHost: selectedGateway?.address,
          sshPort: Number(selectedGateway?.port),
          sshKeyPath: keyPath,
        });
      }
    } catch (e) {
      setTokenError(String(e));
    } finally {
      setIsFetchingToken(false);
    }
  };

  const onTokenSubmit: SubmitEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    setTokenError("");
    try {
      if (tokenSource === "manual") {
        const token = event.currentTarget.token.value;
        if (!token) {
          setTokenError("Token is required");
          return;
        }
        setAskTokenDialog(false);
        await invoke("connect_gateway", {
          address: selectedGateway?.address,
          port: selectedGateway?.port,
          token,
          gatewayType: selectedGateway?.type,
          gatewayMode:
            selectedGateway?.type === "remote" ? "remote-direct" : "local",
          remoteUrl:
            selectedGateway?.type === "remote"
              ? `ws://${selectedGateway?.address}:${selectedGateway?.port}`
              : null,
          sshUser: null,
          sshHost: null,
          sshPort: null,
          sshKeyPath: null,
        });
        // Success path is handled by gateway status updates consumed by this screen.
      } else {
        await fetchTokenFromSSH();
      }
    } catch (err) {
      setTokenError(String(err));
    }
  };

  const onSelectGateway = async (gatewayData: DiscoveredGateway) => {
    const isThisSelected =
      !!selectedGateway && selectedGateway.address === gatewayData.address;
    if (gatewayStatus.connected && isThisSelected) return;

    setSelectedGateway(gatewayData);
    setTokenError("");

    try {
      // Try local token first; only prompt if no token is available.
      const token = await invoke<string>("get_gateway_token");
      if (token) {
        await invoke("connect_gateway", {
          address: gatewayData.address,
          port: gatewayData.port,
          token,
          gatewayType: gatewayData.type,
          gatewayMode:
            gatewayData.type === "remote" ? "remote-direct" : "local",
          remoteUrl:
            gatewayData.type === "remote"
              ? `ws://${gatewayData.address}:${gatewayData.port}`
              : null,
          sshUser: null,
          sshHost: null,
          sshPort: null,
          sshKeyPath: null,
        });
      } else {
        setAskTokenDialog(true);
      }
    } catch {
      setAskTokenDialog(true);
    }
  };

  const onSkip = async () => {
    setMarkingSetupCompleted(true);
    try {
      await invoke("mark_setup_completed");
      navigateNext();
    } catch (err) {
      console.error("Failed to skip setup:", err);
      setMarkingSetupCompleted(false);
    }
  };

  const [localGateway, filteredGateways] = useMemo(() => {
    return [
      gateways.find((g) => ["local", "wsl"].includes(g.type)),
      gateways.filter((g) => !["local", "wsl"].includes(g.type)),
    ];
  }, [gateways]);

  return (
    <SetupLayout
      title="Connect to Gateway"
      description="Connect to an existing OpenClaw Gateway or install locally."
      nextBtnDisabled={!gatewayStatus.connected}
      onNext={handleNext}
    >
      <Card className={styles.container}>
        {isSearching && (
          <ProgressBar
            thickness="medium"
            color="brand"
            className={styles.progress}
          />
        )}

        <div className={styles.gatewayList}>
          <GatewayItem
            name="This Machine"
            subText={localGateway?.fullname}
            description={
              localGateway?.address
                ? `Will connect to existing gateway running ${localGateway.type === "wsl" ? "in WSL" : "on this machine"} at ${localGateway.address}:${localGateway.port}`
                : "Setup Openclaw on this machine"
            }
            onClick={() => {
              if (localGateway) onSelectGateway(localGateway);
              else changeMode("install");
            }}
            isConnected={
              gatewayStatus.connected &&
              gatewayStatus.address === localGateway?.address
            }
            isConnecting={
              !gatewayStatus.connected &&
              selectedGateway?.address === localGateway?.address &&
              !!selectedGateway &&
              !askTokenDialog
            }
          />

          <Divider />

          <div className={styles.discoveryHeader}>
            <RouterFilled />
            <Caption1>
              {isSearching
                ? "Searching nearby gateways..."
                : "Discovered Gateways"}
            </Caption1>
            {!isSearching && (
              <Button
                appearance="subtle"
                size="small"
                onClick={() =>
                  invoke("start_discovery").then(() => {
                    setIsSearching(true);
                    setTimeout(() => {
                      setIsSearching(false);
                      invoke("stop_discovery");
                    }, 30_000);
                  })
                }
              >
                Refresh
              </Button>
            )}
          </div>

          {filteredGateways.map((g) => (
            <GatewayItem
              key={g.fullname}
              name={g.fullname}
              subText={g.type.charAt(0).toUpperCase() + g.type.slice(1)}
              description={[g.address, g.port].filter(Boolean).join(":")}
              onClick={() => onSelectGateway(g)}
              isConnected={
                gatewayStatus.connected && gatewayStatus.address === g.address
              }
              isConnecting={
                !gatewayStatus.connected &&
                selectedGateway?.address === g.address &&
                !askTokenDialog
              }
            />
          ))}

          <Divider />

          <GatewayItem
            name="Configure Later"
            description="Skip gateway setup for now."
            onClick={onSkip}
            isConnecting={markingSetupCompleted}
          />
        </div>

        <Dialog
          open={askTokenDialog}
          onOpenChange={(_, data) => {
            setAskTokenDialog(data.open);
            if (!data.open) {
              setTokenError("");
              if (!gatewayStatus.connected) setSelectedGateway(null);
            }
          }}
        >
          <DialogSurface
            style={{ backgroundColor: tokens.colorNeutralBackground2 }}
          >
            <form onSubmit={onTokenSubmit}>
              <DialogBody>
                <DialogTitle>Setup Gateway Connection</DialogTitle>
                <DialogContent className={styles.dialogContent}>
                  <TabList
                    selectedValue={tokenSource}
                    onTabSelect={(_, data) =>
                      setTokenSource(data.value as "manual" | "ssh")
                    }
                  >
                    <Tab id="manual" value="manual">
                      Manual Entry
                    </Tab>
                    <Tab id="ssh" value="ssh">
                      Automatic (SSH)
                    </Tab>
                  </TabList>

                  {tokenSource === "manual" && (
                    <div className={styles.column}>
                      <Caption1 color="neutralTertiary">
                        If discovery failed, enter the token from your OpenClaw
                        configuration file manually.
                      </Caption1>
                      <Field label="Auth Token">
                        <Input
                          name="token"
                          type="password"
                          placeholder="Enter token..."
                          autoFocus
                        />
                      </Field>
                    </div>
                  )}

                  {tokenSource === "ssh" && (
                    <div className={styles.column}>
                      <Caption1 color="neutralTertiary">
                        This will use your system's SSH client to fetch the
                        token. Ensure SSH access is configured.
                      </Caption1>
                      <Field label="User">
                        <Input
                          value={selectedGateway?.user || ""}
                          onChange={(_, d) =>
                            setSelectedGateway((p) => ({
                              ...p!,
                              user: d.value,
                            }))
                          }
                        />
                      </Field>
                      <div className={styles.row}>
                        <Field label="Target Host / IP" style={{ flex: 1 }}>
                          <Input
                            value={selectedGateway?.address || ""}
                            onChange={(_, d) =>
                              setSelectedGateway((p) => ({
                                ...p!,
                                address: d.value,
                              }))
                            }
                          />
                        </Field>
                        <Field label="Port" style={{ flex: 1 }}>
                          <Input
                            type="number"
                            value={String(selectedGateway?.port || 22)}
                            onChange={(_, d) =>
                              setSelectedGateway((p) => ({
                                ...p!,
                                port: Number(d.value),
                              }))
                            }
                          />
                        </Field>
                      </div>
                      <Field label="Identity File">
                        <div className={styles.row}>
                          <Input
                            style={{ flex: 1 }}
                            value={keyPath || ""}
                            placeholder="Path to .pem or id_rsa..."
                            onChange={(_, d) => setKeyPath(d.value)}
                          />
                          <Button
                            icon={<Folder20Regular />}
                            onClick={async () => {
                              const selected = await open({
                                multiple: false,
                                directory: false,
                                filters: [
                                  {
                                    name: "SSH Key",
                                    extensions: ["pem", "pub", "key", "*"],
                                  },
                                ],
                              });
                              if (selected && typeof selected === "string")
                                setKeyPath(selected);
                            }}
                          >
                            Browse
                          </Button>
                        </div>
                      </Field>
                    </div>
                  )}

                  {tokenError && (
                    <ErrorBanner
                      message={tokenError}
                      onDismiss={() => setTokenError("")}
                    />
                  )}
                </DialogContent>
                <DialogActions style={{ marginTop: 20 }}>
                  <DialogTrigger action="close">
                    <Button disabled={isFetchingToken}>Cancel</Button>
                  </DialogTrigger>
                  <Button
                    type="submit"
                    appearance="primary"
                    disabled={isFetchingToken}
                  >
                    {isFetchingToken ? (
                      <Spinner size="tiny" />
                    ) : tokenSource === "manual" ? (
                      "Connect"
                    ) : (
                      "Fetch Token"
                    )}
                  </Button>
                </DialogActions>
              </DialogBody>
            </form>
          </DialogSurface>
        </Dialog>
      </Card>
    </SetupLayout>
  );
}

const useStyles = makeStyles({
  container: {
    marginTop: "20px",
    width: "80%",
    borderRadius: tokens.borderRadiusXLarge,
    padding: "20px",
    maxHeight: "40vh",
    position: "relative",
    overflow: "visible",
  },
  progress: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: tokens.borderRadiusXLarge,
    borderTopRightRadius: tokens.borderRadiusXLarge,
  },
  gatewayList: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    overflowY: "auto",
  },
  discoveryHeader: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "10px",
    color: tokens.colorNeutralForeground3,
  },
  dialogContent: {
    display: "flex",
    flexDirection: "column",
    rowGap: "10px",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginTop: "10px",
  },
  row: {
    display: "flex",
    flexDirection: "row",
    gap: "10px",
  },
});
