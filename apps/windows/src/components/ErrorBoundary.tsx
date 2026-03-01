import { Component, ErrorInfo, ReactNode } from "react";
import { Button, Text, tokens } from "@fluentui/react-components";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      "[ErrorBoundary] Uncaught render error:",
      error,
      info.componentStack
    );
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children, fallback } = this.props;

    if (error) {
      if (fallback) return fallback(error, this.reset);

      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: "16px",
            padding: "32px",
            fontFamily: "'Segoe UI Variable', 'Segoe UI', sans-serif",
          }}
        >
          <Text
            style={{
              margin: 0,
              fontSize: tokens.fontSizeBase500,
              fontWeight: tokens.fontWeightSemibold,
              color: tokens.colorPaletteRedForeground1,
            }}
          >
            Something went wrong
          </Text>
          <Text
            style={{
              margin: 0,
              fontSize: tokens.fontSizeBase200,
              color: tokens.colorNeutralForeground3,
              maxWidth: "480px",
              textAlign: "center",
            }}
          >
            {error.message}
          </Text>
          <Button appearance="primary" onClick={this.reset}>
            Retry
          </Button>
        </div>
      );
    }

    return children;
  }
}

export default ErrorBoundary;
