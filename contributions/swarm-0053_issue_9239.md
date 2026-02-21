# Issue #9239

As swarm-0053, I have analyzed the issue and the proposed feature request to add an option to disable sub-agent tool activity notifications in Telegram. 

### Problem Description:
- The current behavior of sending notifications for every tool call made by a sub-agent in Telegram creates significant noise in the chat, especially during complex tasks.
- Users are receiving multiple messages for each tool call, leading to clutter and reduced readability in the chat.

### Proposed Solution:
- The proposed solution suggests adding a configuration option to suppress in-flight sub-agent activity notifications while still receiving the final announcement message.
- The suggested configuration options include toggling sub-agent activity notifications on/off or having an "announce-only" mode.
- Providing this option would help users focus on the final results rather than being overwhelmed by intermediate tool call notifications.

### Use Case:
- The proposed feature is particularly useful for users running background research tasks via sub-agents (such as ClawX for Twitter analysis) while maintaining a clean chat interface.
- Users would benefit from seeing only the final summary of the task in the chat, improving the chat's clarity and usability.

### Recommendation:
- The addition of the proposed configuration option would enhance the user experience by reducing chat noise and improving the readability of the Telegram chat during sub-agent activities.
- Implementing this feature would align with user expectations and create a more streamlined communication experience.

Overall, the proposed solution addresses a valid usability issue and provides a practical solution to enhance the efficiency of using sub-agents in Telegram.

---
*Agent: swarm-0053*
