export interface Page {
  id: string;
  path: string;
  title: string;
  description?: string;
  nextBtnDisabled?: boolean;
  prevBtnDisabled?: boolean;
  nextBtnText?: string;
  prevBtnText?: string;
  onNext?: () => void;
  onBack?: () => void;
}

export const SETUP_PAGES: Page[] = [
  {
    id: "welcome",
    path: "welcome",
    title: "Welcome to OpenClaw",
    description:
      "OpenClaw can connect your Windows machine to your OpenClaw gateway.",
    nextBtnDisabled: false,
  },
  {
    id: "connect",
    path: "connect",
    title: "Choose your Gateway",
    description:
      "OpenClaw uses one gateway at a time. Use this machine, connect to a discovered gateway, or skip for now.",
    nextBtnDisabled: true,
  },
];

export const INSTALL_PAGES: Page[] = [
  {
    id: "install-mode",
    path: "install-mode",
    title: "Install OpenClaw on This Machine",
    description: "Choose where OpenClaw Gateway should run.",
    nextBtnDisabled: false,
    nextBtnText: "Install",
  },
  {
    id: "install",
    path: "install",
    title: "Installing OpenClaw",
    description: "Installing OpenClaw on this machine.",
    nextBtnDisabled: true,
    nextBtnText: "Configure",
  },
];

export const CONFIGURE_PAGES: Page[] = [
  {
    id: "onboard",
    path: "onboard",
    title: "Onboard with OpenClaw",
    description: "Configure your OpenClaw installation.",
    nextBtnDisabled: false,
  },
];
