# Onboarding Flow Reference

How to handle onboarding as a proactive agent.

## Detection

At session start, check for `ONBOARDING.md`:

```
if ONBOARDING.md exists:
    if status == "not_started":
        offer to begin onboarding
    elif status == "in_progress":
        offer to resume or continue drip
    elif status == "complete":
        normal operation
else:
    # No onboarding file = skip onboarding
    normal operation
```

## Modes

### Interactive Mode
User wants to answer questions now.

```
1. "Great! I have 12 questions. Should take ~10 minutes."
2. Ask questions conversationally, not robotically
3. After each answer:
   - Update ONBOARDING.md (mark answered, save response)
   - Update USER.md or SOUL.md with the info
4. If interrupted mid-session:
   - Progress is already saved
   - Next session: "We got through X questions. Continue?"
5. When complete:
   - Set status to "complete"
   - Summarize what you learned
   - "I'm ready to start being proactive!"
```

### Drip Mode
User is busy or prefers gradual.

```
1. "No problem! I'll learn about you over time."
2. Set mode to "drip" in ONBOARDING.md
3. Each session, if unanswered questions remain:
   - Ask ONE question naturally
   - Weave it into conversation, don't interrogate
   - Example: "By the way, I realized I don't know your timezone..."
4. Learn opportunistically from conversation too
5. Mark complete when enough context gathered
```

### Skip Mode
User doesn't want formal onboarding.

```
1. "Got it. I'll learn as we go."
2. Agent works immediately with defaults
3. Fills in USER.md from natural conversation
4. May never formally "complete" onboarding — that's fine
```

## Question Flow

Don't ask robotically. Weave into conversation:

❌ Bad: "Question 1: What should I call you?"
✅ Good: "Before we dive in — what would you like me to call you?"

❌ Bad: "Question 5: What is your primary goal?"
✅ Good: "I'd love to understand what you're working toward. What's the main thing you're trying to accomplish right now?"

## Opportunistic Learning

Even outside formal onboarding, notice and capture:

| User Says | Learn |
|-----------|-------|
| "I'm in New York" | Timezone: America/New_York |
| "I hate long emails" | Communication: brief |
| "My cofounder Sarah..." | Key person: Sarah (cofounder) |
| "I'm building an app for..." | Current project |

Update USER.md and mark corresponding onboarding question as answered.

## Handling Interruption

### Mid-Question Interruption
```
User: "Actually, hold on — need to take this call"
Agent: "No problem! We can pick this up anytime."
[Save progress, don't ask again this session]
```

### Multi-Day Gap
```
Session 1: Answered 4 questions, got interrupted
[3 days pass]
Session 2: "Hey! Last time we were getting to know each other. 
           Want to continue, or should I just ask occasionally?"
```

### User Seems Annoyed
```
If user seems impatient with questions:
- Stop asking
- Switch to opportunistic learning only
- Note in ONBOARDING.md: "User prefers organic learning"
```

## Completion Criteria

Onboarding is "complete enough" when you have:

**Minimum viable:**
- Name
- Primary goal or current project
- Communication preference (even if inferred)

**Ideal:**
- All 12 questions answered
- USER.md fully populated
- SOUL.md personality configured

**Reality:**
- Many users will never formally complete
- That's okay — agent adapts
- Keep learning from every interaction

## Post-Onboarding

When status changes to "complete":

1. Summarize what you learned:
   ```
   "Okay, here's what I've got:
   - You're [Name], based in [Timezone]
   - You're working on [Project] toward [Goal]
   - You prefer [communication style]
   - Key people: [list]
   
   Anything I got wrong or missed?"
   ```

2. Explain what's next:
   ```
   "I'm now in proactive mode. I'll:
   - Check in during heartbeats
   - Look for ways to help without being asked
   - Build things I think you'll find useful
   
   I'll always check before doing anything external."
   ```

3. Transition to normal operation
