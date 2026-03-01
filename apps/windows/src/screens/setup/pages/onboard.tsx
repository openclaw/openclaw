import {
  Caption1,
  Image,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

import { useSetup } from "../context";
import { OnboardingTerminal } from "../components/OnboardingTerminal";

export const SetupOnboard = () => {
  const styles = useStyles();
  const { navigateNext } = useSetup();

  const handleExit = (code: number) => {
    console.log("[SetupOnboard] Terminal exited with code:", code);
    if (code === 0) {
      navigateNext();
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Image src="/openclaw-logo.svg" width={24} height={24} />
        <Caption1>OpenClaw Onboarding</Caption1>
      </div>
      <OnboardingTerminal className={styles.terminal} onExit={handleExit} />
    </div>
  );
};

const useStyles = makeStyles({
  container: {
    width: "100%",
    height: "100vh",
    borderRadius: tokens.borderRadiusXLarge,
    padding: "0",
    overflow: "hidden",
  },
  header: {
    padding: "5px 16px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  terminal: {
    width: "100%",
    height: "100%",
  },
});
