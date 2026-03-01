import { useEffect, useState } from "react";
import {
  makeStyles,
  tokens,
  Spinner,
  Body1,
  Title3,
  Image,
  Caption1,
} from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { useSetup } from "../context";
import gateway from "../../../gateway";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100vh",
    backgroundColor: tokens.colorNeutralBackground1,
    gap: "24px",
  },
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    padding: "5px 16px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "12px",
  },
});

interface OpenClawConfig {
  gateway: {
    port: number;
    mode: "local" | "remote";
    auth: {
      token: string;
    };
    remote?: {
      url: string;
      token: string;
    };
  };
}

export const SetupConnecting = () => {
  const styles = useStyles();
  const { navigateNext } = useSetup();
  const [statusText, setStatusText] = useState("Retrieving configuration...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const connect = async () => {
      try {
        // Load gateway config first so this step works for both local and remote modes.
        setStatusText("Reading OpenClaw configuration...");
        const config = await invoke<OpenClawConfig>("read_openclaw_config", {
          distro: null,
        });
        console.log("[SetupConnecting] Config loaded:", config);

        // Normalize config into the connect_gateway payload shape.
        let address = "127.0.0.1";
        let port = config.gateway.port;
        let token = config.gateway.auth.token;
        const type: "local" | "remote" = config.gateway.mode;
        let gatewayMode: "local" | "remote-direct" = "local";
        let remoteUrl: string | null = null;

        if (type === "remote" && config.gateway.remote) {
          const url = new URL(config.gateway.remote.url);
          address = url.hostname;
          port =
            url.port.length > 0
              ? parseInt(url.port, 10)
              : url.protocol === "wss:" || url.protocol === "https:"
                ? 443
                : 18789;
          token = config.gateway.remote.token;
          gatewayMode = "remote-direct";
          remoteUrl = config.gateway.remote.url;
        }

        // Connect with the derived gateway type and auth token.
        setStatusText(`Connecting to ${type} gateway at ${address}:${port}...`);
        const connectParams = {
          address,
          port,
          token,
          gatewayType: type === "local" ? "wsl" : "remote",
          gatewayMode,
          remoteUrl,
          sshUser: null,
          sshHost: null,
          sshPort: null,
          sshKeyPath: null,
        };
        console.log(
          "[SetupConnecting] Calling connect_gateway with:",
          connectParams
        );

        await invoke("connect_gateway", connectParams);

        // Wait for websocket readiness before leaving setup.
        setStatusText("Authenticating with gateway...");
        await gateway.onReady();

        if (isMounted) {
          setStatusText("Connected successfully!");
          // Keep success state visible briefly so the transition feels intentional.
          setTimeout(() => {
            navigateNext();
          }, 1000);
        }
      } catch (err: unknown) {
        console.error("[SetupConnecting] Workflow failed:", err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : String(err));
          setStatusText("Connection failure");
        }
      }
    };

    connect();

    return () => {
      isMounted = false;
    };
  }, [navigateNext]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Image src="/openclaw-logo.svg" width={24} height={24} />
        <Caption1>OpenClaw Setup</Caption1>
      </div>

      <div className={styles.card}>
        <Image src="/openclaw-logo.svg" width={64} height={64} />
        <Title3>Finalizing Setup</Title3>
        {!error ? (
          <>
            <Spinner size="medium" />
            <Body1>{statusText}</Body1>
          </>
        ) : (
          <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>
            Error: {error}
          </Body1>
        )}
      </div>
    </div>
  );
};

export default SetupConnecting;
