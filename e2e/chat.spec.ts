import { test, expect } from "@playwright/test";

test.describe("Chat Interface", () => {
  test("should load the application", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("openclaw-app")).toBeVisible();
  });

  test("should have chat compose area", async ({ page }) => {
    await page.goto("/");
    // Look for the textarea element in chat view
    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible();
  });

  test("should have send button", async ({ page }) => {
    await page.goto("/");
    // Look for the send button with "Send" or "Queue" text
    const sendButton = page.locator(
      'button.primary:has-text("Send"), button.primary:has-text("Queue")',
    );
    await expect(sendButton).toBeVisible();
  });

  test("send button should log debug info when clicked", async ({ page }) => {
    await page.goto("/");

    // Set up console listener to capture logs
    const consoleMessages: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "info" && msg.text().includes("[chat] send click")) {
        consoleMessages.push(msg.text());
      }
    });

    // Find and click the send button
    const sendButton = page.locator(
      'button.primary:has-text("Send"), button.primary:has-text("Queue")',
    );
    await sendButton.click();

    // Wait a bit for console message
    await page.waitForTimeout(100);

    // Verify the debug log was created
    expect(consoleMessages.length).toBeGreaterThan(0);
    expect(consoleMessages[0]).toContain("[chat] send click");
  });
});
