import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  makeStyles,
  mergeClasses,
  tokens,
  Text,
} from "@fluentui/react-components";
import {
  SettingsRegular,
  MicRegular,
  DesktopRegular,
  ClockRegular,
  FlashRegular,
  LockClosedRegular,
  InfoRegular,
  BugRegular,
} from "@fluentui/react-icons";
import { GeneralTab } from "./tabs/GeneralTab";
import ChannelsTab from "./tabs/ChannelsTab";
import { VoiceWakeTab } from "./tabs/VoiceWakeTab";
import { ConfigTab } from "./tabs/ConfigTab";
import { InstancesTab } from "./tabs/InstancesTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { CronTab } from "./tabs/CronTab";
import { SkillsTab } from "./tabs/SkillsTab";
import { PermissionsTab } from "./tabs/PermissionsTab";
import { DebugTab } from "./tabs/DebugTab";

type TabId =
  | "general"
  | "channels"
  | "voice-wake"
  | "config"
  | "instances"
  | "sessions"
  | "cron"
  | "skills"
  | "settings"
  | "permissions"
  | "about"
  | "debug";

interface NavItem {
  id: TabId;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "General", icon: <SettingsRegular /> },
  // { id: "channels", label: "Channels", icon: <PlugConnectedRegular /> },
  { id: "voice-wake", label: "Voice Wake", icon: <MicRegular /> },
  // { id: "config", label: "Config", icon: <DocumentRegular /> },
  { id: "instances", label: "Instances", icon: <DesktopRegular /> },
  // { id: "sessions", label: "Sessions", icon: <AppsRegular /> },
  { id: "cron", label: "Cron", icon: <ClockRegular /> },
  { id: "skills", label: "Skills", icon: <FlashRegular /> },
  { id: "permissions", label: "Permissions", icon: <LockClosedRegular /> },
  { id: "debug", label: "Debug", icon: <BugRegular /> },
];

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "row",
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    backgroundColor: tokens.colorTransparentBackground,
  },
  sidebar: {
    width: "176px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "48px 8px 16px 8px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sectionLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    padding: "6px 10px 4px 10px",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "8px",
    width: "100%",
    minWidth: "auto",
    padding: "6px 10px",
    borderRadius: "6px",
    userSelect: "none",
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    transition: "background-color 0.1s ease, color 0.1s ease",
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackground1Selected,
      color: tokens.colorNeutralForeground1,
    },
  },
  navItemActive: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightSemibold,
    "& svg": {
      color: tokens.colorNeutralForegroundOnBrand,
    },
    "&:hover": {
      backgroundColor: tokens.colorBrandBackgroundHover,
      color: tokens.colorNeutralForegroundOnBrand,
    },
  },
  navIcon: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    fontSize: "16px",
  },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  contentInner: {
    flex: 1,
    overflowY: "auto",
    padding: "32px 36px 24px 36px",
  },
  tabTitle: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase600,
    marginBottom: "20px",
    display: "block",
  },
});

function TabContent({ activeTab }: { activeTab: TabId }) {
  switch (activeTab) {
    case "general":
      return <GeneralTab />;
    case "channels":
      return <ChannelsTab />;
    case "voice-wake":
      return <VoiceWakeTab />;
    case "config":
      return <ConfigTab />;
    case "instances":
      return <InstancesTab />;
    case "sessions":
      return <SessionsTab />;
    case "cron":
      return <CronTab />;
    case "skills":
      return <SkillsTab />;
    case "permissions":
      return <PermissionsTab />;
    case "debug":
      return <DebugTab />;
    default:
      return null;
  }
}

export default function Settings() {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [showDebug, setShowDebug] = useState(false);
  const styles = useStyles();

  useEffect(() => {
    // Re-read config on tab switch so Debug visibility updates immediately.
    invoke<{ debugPaneEnabled?: boolean }>("get_full_config")
      .then((cfg) => setShowDebug(cfg.debugPaneEnabled ?? false))
      .catch(() => {});
  }, [activeTab]);

  useEffect(() => {
    const onDebugPaneChanged = (event: Event) => {
      const custom = event as CustomEvent<{ enabled?: boolean }>;
      setShowDebug(custom.detail?.enabled ?? false);
    };
    window.addEventListener("settings:debug-pane", onDebugPaneChanged);
    return () => {
      window.removeEventListener("settings:debug-pane", onDebugPaneChanged);
    };
  }, []);

  const active = NAV_ITEMS.find((n) => n.id === activeTab);

  return (
    <div className={styles.root}>
      <nav className={styles.sidebar} aria-label="Settings navigation">
        <Text className={styles.sectionLabel}>OpenClaw</Text>
        {NAV_ITEMS.filter((item) => {
          if (item.id === "debug") return showDebug;
          return true;
        }).map((item) => (
          <Button
            key={item.id}
            appearance="transparent"
            className={mergeClasses(
              styles.navItem,
              activeTab === item.id && styles.navItemActive
            )}
            icon={<span className={styles.navIcon}>{item.icon}</span>}
            aria-current={activeTab === item.id ? "page" : undefined}
            aria-pressed={activeTab === item.id}
            onClick={() => setActiveTab(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </nav>

      <main className={styles.content}>
        <div className={styles.contentInner}>
          <Text className={styles.tabTitle}>{active?.label}</Text>
          <TabContent activeTab={activeTab} />
        </div>
      </main>
    </div>
  );
}
