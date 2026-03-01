import {
  Card,
  makeStyles,
  tokens,
  Divider,
  Body1,
  Caption1,
  Tag,
  Spinner,
  Text,
} from "@fluentui/react-components";
import { useSetup } from "../context";
import { useEffect, useState } from "react";
import {
  CheckmarkCircle20Filled,
  Warning20Filled,
} from "@fluentui/react-icons";
import { getWSLDistro, isWSLInstalled } from "../../../utils/wsl";
import { SetupLayout } from "../layout";

interface ItemProps {
  onClick: () => void;
  title: string;
  description: string;
  isSelected: boolean;
  tags?: React.ReactNode[];
  disabled?: boolean;
}

const Item = ({
  onClick,
  title,
  description,
  isSelected,
  tags,
  disabled,
}: ItemProps) => {
  return (
    <Card
      appearance="subtle"
      onClick={disabled ? undefined : onClick}
      style={{
        justifyContent: "space-between",
        flexDirection: "row",
        alignItems: "center",
        ...(disabled && { opacity: 0.5, cursor: "not-allowed" }),
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <Body1>{title}</Body1>
          {tags && tags}
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {description}
        </Caption1>
      </div>
      {disabled ? (
        <Text style={{ color: tokens.colorNeutralForeground3 }}>
          Not yet supported
        </Text>
      ) : isSelected ? (
        <CheckmarkCircle20Filled />
      ) : (
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 18,
            backgroundColor: tokens.colorNeutralBackground1Selected,
          }}
        />
      )}
    </Card>
  );
};

export const SetupInstallMode = () => {
  const styles = useStyles();
  const { installData, updateInstallData } = useSetup();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadWslStatus = async () => {
      try {
        const isInstalled = await isWSLInstalled();
        if (!isInstalled) {
          if (!cancelled) setIsLoading(false);
          return;
        }
        const wslDistro = await getWSLDistro();
        if (!cancelled) {
          updateInstallData({ wslDistro });
          setIsLoading(false);
        }
      } catch (error) {
        console.error("Failed to detect WSL status", error);
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadWslStatus();
    return () => {
      cancelled = true;
    };
  }, [updateInstallData]);

  const handleSelect = (mode: "windows" | "wsl") => {
    updateInstallData({ installMode: mode });
  };

  return (
    <SetupLayout
      title="Install OpenClaw on This Machine"
      description="Choose where OpenClaw Gateway should run."
      nextBtnDisabled={!installData.installMode}
    >
      <Card className={styles.container}>
        <div className={styles.gatewayList}>
          <Item
            title="Direct Install"
            description="Openclaw will be installed directly on this windows machine"
            onClick={() => handleSelect("windows")}
            isSelected={installData.installMode === "windows"}
            disabled
          />

          <Divider />
          <Item
            title="WSL Install"
            description={`Openclaw will be installed on WSL`}
            onClick={() => handleSelect("wsl")}
            isSelected={installData.installMode === "wsl"}
            tags={[
              <Tag
                key="recommended"
                appearance="filled"
                size="small"
                style={{
                  backgroundColor: tokens.colorBrandBackground,
                  marginLeft: 20,
                }}
                icon={<CheckmarkCircle20Filled />}
              >
                Recommended
              </Tag>,
              installData.wslDistro ? (
                <Tag
                  key="distro"
                  appearance="filled"
                  size="small"
                  style={{
                    backgroundColor: tokens.colorBrandBackground,
                    marginLeft: 20,
                  }}
                  icon={<CheckmarkCircle20Filled />}
                >
                  {installData.wslDistro}
                </Tag>
              ) : (
                <Tag
                  key="wsl-status"
                  appearance="filled"
                  size="small"
                  style={{
                    backgroundColor: tokens.colorStatusWarningBackground1,
                    marginLeft: 20,
                  }}
                  icon={
                    isLoading ? <Spinner size="tiny" /> : <Warning20Filled />
                  }
                >
                  {isLoading
                    ? "  Checking WSL"
                    : "WSL (Ubuntu) will be installed"}
                </Tag>
              ),
            ]}
          />
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
    padding: "20px",
    maxHeight: "40vh",
    position: "relative",
    overflow: "visible",
  },
  gatewayList: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    overflowY: "auto",
  },
});
