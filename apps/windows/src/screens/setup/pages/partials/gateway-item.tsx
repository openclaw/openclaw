import {
  Body1,
  Caption1,
  Card,
  Divider,
  Spinner,
  Tag,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowCircleRight20Regular,
  CheckmarkCircleFilled,
} from "@fluentui/react-icons";

export const GatewayItem = ({
  name,
  subText,
  description,
  isConnected,
  isConnecting,
  onClick,
}: {
  name: string;
  subText?: string;
  description: string;
  onClick: () => void;
  isConnected?: boolean;
  isConnecting?: boolean;
}) => (
  <Card
    key={name}
    appearance="subtle"
    onClick={onClick}
    disabled={isConnected}
    style={{
      justifyContent: "space-between",
      flexDirection: "row",
      alignItems: "center",
      height: "auto",
      minHeight: "fit-content",
    }}
  >
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div
        style={{ display: "flex", flexDirection: "row", alignItems: "center" }}
      >
        <Body1>{name}</Body1>
        {subText && (
          <Divider vertical style={{ flexGrow: "unset", margin: "0 20px" }} />
        )}
        {subText && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {subText}
          </Caption1>
        )}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {description}
      </Caption1>
    </div>
    {isConnected ? (
      <Tag
        appearance="filled"
        style={{ backgroundColor: tokens.colorStatusSuccessBackground3 }}
        icon={<CheckmarkCircleFilled />}
      >
        Connected
      </Tag>
    ) : isConnecting ? (
      <Spinner size="tiny" />
    ) : (
      <ArrowCircleRight20Regular />
    )}
  </Card>
);
