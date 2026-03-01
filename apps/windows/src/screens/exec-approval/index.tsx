import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Text,
  makeStyles,
  tokens,
  Subtitle2,
  Caption1,
} from "@fluentui/react-components";
import {
  ShieldLockRegular,
  ShieldCheckmarkRegular,
  DismissRegular,
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    padding: "20px",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    backgroundColor: tokens.colorNeutralBackground1,
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: tokens.colorBrandForeground1,
  },
  commandBox: {
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: "monospace",
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    flex: 1,
    overflowY: "auto",
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  id: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    textAlign: "right",
  },
});

export default function ExecApprovalScreen() {
  const styles = useStyles();
  const [params] = useState<{
    id: string;
    command: string;
    agentId?: string;
  } | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get("id");
    const command = urlParams.get("command");
    const agentId = urlParams.get("agentId") || undefined;
    return id && command ? { id, command, agentId } : null;
  });

  const resolve = async (decision: "allowonce" | "allowalways" | "deny") => {
    if (!params) return;
    try {
      await invoke("resolve_exec_approval_handler", {
        id: params.id,
        decision,
      });
      // The backend will close the window, but we can also signal completion
    } catch (e) {
      console.error("Failed to resolve approval", e);
    }
  };

  if (!params) {
    return (
      <div className={styles.root}>
        <Text>Loading request details...</Text>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <ShieldLockRegular fontSize={24} />
        <Subtitle2>Security Approval Required</Subtitle2>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <Text size={200} weight="semibold">
          An agent {params.agentId ? `(${params.agentId})` : ""} wants to run:
        </Text>
        <div className={styles.commandBox}>{params.command}</div>
      </div>

      <div className={styles.actions}>
        <Button
          appearance="primary"
          icon={<ShieldCheckmarkRegular />}
          onClick={() => resolve("allowonce")}
        >
          Allow Once
        </Button>
        <Button appearance="outline" onClick={() => resolve("allowalways")}>
          Allow Always
        </Button>
        <Button
          appearance="subtle"
          icon={<DismissRegular />}
          onClick={() => resolve("deny")}
        >
          Deny
        </Button>
      </div>

      <Caption1 className={styles.id}>ID: {params.id}</Caption1>
    </div>
  );
}
