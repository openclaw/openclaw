import {
  Body1,
  Button,
  Image,
  makeStyles,
  Spinner,
  Title1,
  tokens,
} from "@fluentui/react-components";
import { useSetup } from "./context";
import { ReactNode } from "react";

export interface SetupLayoutProps {
  title?: string;
  description?: string;
  children: ReactNode;

  hideImage?: boolean;
  hideDescription?: boolean;

  nextBtnText?: string;
  nextBtnDisabled?: boolean;
  onNext?: () => void;

  prevBtnText?: string;
  prevBtnDisabled?: boolean;
  onBack?: () => void;
}

export const SetupLayout = (props: SetupLayoutProps) => {
  const { title, description, children, hideImage, hideDescription } = props;
  const { pages, activePage, navigateNext, navigateBack, isLoading } =
    useSetup();

  const styles = useStyles();

  const handleNext = () => {
    if (props.onNext) {
      props.onNext();
    } else {
      navigateNext();
    }
  };

  const handleBack = () => {
    if (props.onBack) {
      props.onBack();
    } else {
      navigateBack();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        height: "100vh",
      }}
    >
      {!hideImage && (
        <Image
          shadow
          src="/assets/openclaw-mac.png"
          alt=""
          style={{
            width: 100,
            height: 100,
            objectFit: "contain",
            borderRadius: 20,
            marginTop: 60,
          }}
        />
      )}

      <div className={styles.content}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            alignItems: "center",
          }}
        >
          {title && <Title1>{title}</Title1>}

          {!hideDescription && description && (
            <Body1
              style={{
                marginTop: 10,
                color: tokens.colorNeutralForeground3,
                maxWidth: "80%",
              }}
              align="center"
            >
              {description}
            </Body1>
          )}

          <div className={styles.outletContainer}>{children}</div>
        </div>
      </div>

      <div className={styles.footer}>
        <Button
          onClick={handleBack}
          disabled={props.prevBtnDisabled || isLoading !== "idle"}
          icon={isLoading === "back" ? <Spinner size="tiny" /> : undefined}
        >
          {props.prevBtnText || "Previous"}
        </Button>

        <div className={styles.dots}>
          {pages.map((_, index) => (
            <div
              key={index}
              className={activePage === index ? styles.activeDot : styles.dot}
            />
          ))}
        </div>

        <Button
          appearance="primary"
          onClick={handleNext}
          disabled={props.nextBtnDisabled || isLoading !== "idle"}
          icon={isLoading === "next" ? <Spinner size="tiny" /> : undefined}
        >
          {props.nextBtnText || "Next"}
        </Button>
      </div>
    </div>
  );
};

const useStyles = makeStyles({
  content: {
    padding: "20px 0",
    height: "60vh",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  outletContainer: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    animationName: {
      from: { opacity: 0, transform: "translateY(10px)" },
      to: { opacity: 1, transform: "translateY(0)" },
    },
    animationDuration: "0.4s",
    animationIterationCount: 1,
    animationFillMode: "forwards",
  },
  footer: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "auto",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingVerticalXXL} ${tokens.spacingVerticalXXL} ${tokens.spacingVerticalXXL}`,
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
  },
  dots: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: tokens.colorNeutralStroke1,
    transition: "all 0.2s ease",
  },
  activeDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    transition: "all 0.2s ease",
  },
});
