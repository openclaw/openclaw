import React from "react";
import {
  makeStyles,
  shorthands,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
  Button,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  container: {
    width: "100%",
    ...shorthands.margin("10px", "0"),
  },
});

interface ErrorBannerProps {
  title?: string;
  message: string;
  intent?: "error" | "warning" | "info" | "success";
  onDismiss?: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  title,
  message,
  intent = "error",
  onDismiss,
  actionLabel,
  onAction,
}) => {
  const styles = useStyles();

  return (
    <div className={styles.container}>
      <MessageBar intent={intent}>
        <MessageBarBody>
          {title && <MessageBarTitle>{title}</MessageBarTitle>}
          {message}
        </MessageBarBody>
        {(actionLabel || onDismiss) && (
          <MessageBarActions>
            {actionLabel && onAction && (
              <Button appearance="subtle" onClick={onAction}>
                {actionLabel}
              </Button>
            )}
            {onDismiss && (
              <Button appearance="subtle" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </MessageBarActions>
        )}
      </MessageBar>
    </div>
  );
};
