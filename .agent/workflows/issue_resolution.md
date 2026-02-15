---
description: How to resolve an issue in the OpenClaw codebase.
---

1.  **Analyze the Issue**:
    - Read the issue description carefully.
    - Identify the core problem and expected behavior.
    - Search for existing solutions or similar issues.

2.  **Reproduce the Issue**:
    - Create a minimal reproduction test case.
    - Verify the failure with the test case.

3.  **Plan the Fix**:
    - Create an `implementation_plan.md` artifact.
    - Outline the proposed changes and verification steps.
    - **Brutal Review**: Review the plan critically for edge cases and regressions.

4.  **Implement the Fix**:
    - Write the code to fix the issue.
    - Follow the project's coding standards and style guide.

5.  **Verify the Fix**:
    - Run the reproduction test case to confirm the fix.
    - Run the full test suite for the affected component.
    - **Critical**: Run a full project type check (`pnpm exec tsc --noEmit`) to catch cross-module type errors (e.g., TS2742).
    - Perform manual verification if applicable.

6.  **Finalize**:
    - Review the changes again ("Brutal Review").
    - Commit the changes with a descriptive message.
    - Push the branch and create a Pull Request.
    - Check CI status and address any failures.
