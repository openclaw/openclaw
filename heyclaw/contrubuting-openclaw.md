# Contributing to OpenClaw

Welcome! We appreciate your interest in contributing to OpenClaw. This document guides you through the process of fetching issues, planning your contribution, and submitting a Pull Request (PR).

## 1. Finding Issues to Work On

We track our work on [GitHub Issues](https://github.com/openclaw/openclaw/issues).

### Current Focus Issues
We have identified the following issues as high priority or good starting points:

*   **Issue #4629: Include day of week in date/time context injection**
    *   *Problem*: The agent sometimes hallucinates the day of the week because it's not explicitly provided in the system prompt.
    *   *Goal*: Update `src/agents/system-prompt.ts` to include the weekday (e.g., "Friday, January 30, 2026").
*   **Issue #4631: Add Simplified Chinese (zh-CN) localization support for Control UI**
    *   *Problem*: The UI lacks `zh-CN` support.
    *   *Goal*: Add localization strings for the Control UI.

## 2. Setting Up Your Environment

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    ```
2.  **Install dependencies**:
    ```bash
    npm install
    # or
    pnpm install
    ```

## 3. Making Changes

1.  **Create a new branch**:
    ```bash
    git checkout -b feature/your-feature-name
    ```
2.  **Implement your changes**.
3.  **Run tests** to ensure no regressions:
    ```bash
    npm test
    # or specific tests
    vitest src/agents/system-prompt.test.ts
    ```

## 4. Submitting a Pull Request (PR)

Once you are happy with your changes, follow these steps to submit them:

1.  **Stage your changes**:
    ```bash
    git add .
    ```
2.  **Commit your changes** with a meaningful message:
    ```bash
    git commit -m "fix(agent): include day of week in system prompt (#4629)"
    ```
3.  **Push to your fork** (or the main repo if you have access):
    ```bash
    git push origin feature/your-feature-name
    ```
4.  **Open a Pull Request**:
    *   Go to the [OpenClaw GitHub repository](https://github.com/openclaw/openclaw).
    *   You should see a prompt to compare & pull request.
    *   Fill in the PR template, linking the issue you fixed (e.g., "Fixes #4629").
    *   Submit!

Happy coding! 🦞
