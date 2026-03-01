import { Body1, Card, Subtitle2, tokens } from "@fluentui/react-components";
import { Warning20Filled } from "@fluentui/react-icons";
import { SetupLayout } from "../layout";

export default function SetupWelcomePage() {
  return (
    <SetupLayout
      title="Welcome to OpenClaw"
      description="OpenClaw can connect your Windows machine to your OpenClaw gateway."
    >
      <Card
        style={{
          marginTop: 20,
          maxWidth: "80%",
          borderRadius: 20,
          padding: 20,
        }}
      >
        <div style={{ display: "flex", gap: 20 }}>
          <Warning20Filled color={tokens.colorStatusWarningForeground1} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <Subtitle2>Security Notice</Subtitle2>
            <Body1
              style={{ marginTop: 10, color: tokens.colorNeutralForeground3 }}
            >
              The connected AI agent (for example, Claude) can run actions on
              your Windows machine,
              <br />
              including running commands, reading/writing files, and capturing
              screenshots depending on the permissions you grant.
              <br />
              <br />
              Enable OpenClaw only if you trust the prompts, skills, and
              integrations you use.
            </Body1>
          </div>
        </div>
      </Card>
    </SetupLayout>
  );
}
