---
name: scripts
description: Writing effective scripts for HeyGen AI avatar videos
metadata:
  tags: scripts, writing, pauses, breaks, pacing, speech
---

# Writing Scripts for HeyGen Videos

Scripts for AI avatar videos have different requirements than scripts for human presenters. This guide covers best practices for writing scripts that sound natural and render well.

## Script Basics

### Speech Rate and Duration

Typical speech is approximately **150 words per minute** at normal speed (1.0x). Use this as a rough estimate for planning script length.

| Script Length | Approximate Duration |
|---------------|---------------------|
| 75 words | 30 seconds |
| 150 words | 1 minute |
| 300 words | 2 minutes |
| 450 words | 3 minutes |
| 750 words | 5 minutes |

```typescript
// Estimate video duration from script
function estimateDuration(script: string, speed: number = 1.0): number {
  const words = script.split(/\s+/).filter(w => w.length > 0).length;
  const wordsPerMinute = 150 * speed;
  return words / wordsPerMinute * 60; // seconds
}

// Estimate frames for Remotion
function estimateFrames(script: string, fps: number = 30, speed: number = 1.0): number {
  const durationSeconds = estimateDuration(script, speed);
  return Math.ceil(durationSeconds * fps);
}
```

### Sentence Structure

**Keep sentences short.** AI voices handle shorter sentences more naturally.

| Guideline | Example |
|-----------|---------|
| **Good**: 10-20 words per sentence | "Our platform helps teams collaborate. It syncs in real-time across all devices." |
| **Avoid**: 30+ word run-on sentences | "Our platform helps teams collaborate more effectively by providing real-time synchronization across all devices while also offering offline support and automatic conflict resolution." |

### Punctuation Affects Delivery

| Punctuation | Effect |
|-------------|--------|
| Period `.` | Full stop, natural pause |
| Comma `,` | Brief pause |
| Question mark `?` | Rising intonation |
| Exclamation `!` | Emphasis (use sparingly) |
| Ellipsis `...` | Trailing off, slight pause |

## Adding Pauses with Break Tags

Use SSML-style `<break>` tags for precise pause control:

```
<break time="Xs"/>
```

Where `X` is seconds (e.g., `0.5s`, `1s`, `1.5s`, `2s`).

### Formatting Rules

| Rule | Correct | Incorrect |
|------|---------|-----------|
| Space before tag | `word <break time="1s"/>` | `word<break time="1s"/>` |
| Space after tag | `<break time="1s"/> word` | `<break time="1s"/>word` |
| Use seconds with "s" | `<break time="1.5s"/>` | `<break time="1500ms"/>` |
| Self-closing tag | `<break time="1s"/>` | `<break time="1s"></break>` |

### When to Use Pauses

| Situation | Recommended Pause | Example |
|-----------|-------------------|---------|
| After greeting | 0.5-1s | `Hello! <break time="0.5s"/> Welcome to...` |
| Between sections | 1-1.5s | `...that's feature one. <break time="1.5s"/> Now let's look at...` |
| Before key point | 0.5s | `The most important thing is <break time="0.5s"/> consistency.` |
| For dramatic effect | 1.5-2s | `And the winner is... <break time="2s"/> you!` |
| After question | 1s | `Sound good? <break time="1s"/> Let's get started.` |
| List items | 0.5s | `First, speed. <break time="0.5s"/> Second, reliability.` |

### Pause Duration Guide

| Duration | Feel | Use For |
|----------|------|---------|
| 0.3-0.5s | Brief breath | Between clauses, light emphasis |
| 0.5-1s | Natural pause | Sentence breaks, transitions |
| 1-1.5s | Deliberate pause | Section changes, setup for key points |
| 1.5-2s | Dramatic | Reveals, important announcements |
| 2s+ | Long pause | Use sparingly, can feel unnatural |

### Examples

```typescript
// Section transitions
const script = `
Welcome to our product overview. <break time="1s"/>

Today I'll cover three key features. <break time="0.5s"/>
First, let's look at the dashboard. <break time="1.5s"/>

As you can see, it's designed for simplicity. <break time="0.5s"/>
Every action is just one click away.
`;

// Building suspense
const announcement = `
We've been working on something special. <break time="1s"/>
After months of development... <break time="1.5s"/>
I'm excited to announce <break time="0.5s"/> our new AI assistant.
`;

// List with rhythm
const features = `
Our platform offers three core benefits. <break time="0.5s"/>
Speed. <break time="0.5s"/>
Reliability. <break time="0.5s"/>
And simplicity. <break time="1s"/>
Let me show you each one.
`;
```

### Consecutive Breaks

Multiple consecutive breaks are combined:

```typescript
// These two breaks:
"Hello <break time=\"1s\"/> <break time=\"0.5s\"/> world"

// Are treated as a single 1.5s pause
```

## Script Structure Templates

### Product Demo (60 seconds, ~150 words)

```typescript
const productDemo = `
Hi, I'm [Name], and I'm excited to show you [Product]. <break time="1s"/>

[Product] helps you [main benefit] in just [timeframe]. <break time="0.5s"/>

Here's how it works. <break time="1s"/>

First, [step 1]. <break time="0.5s"/>
Then, [step 2]. <break time="0.5s"/>
And finally, [step 3]. <break time="1s"/>

What used to take [old time] now takes [new time]. <break time="0.5s"/>

Ready to get started? <break time="0.5s"/>
Visit [website] today.
`;
```

### Tutorial Introduction (90 seconds, ~225 words)

```typescript
const tutorial = `
Welcome to this tutorial on [topic]. <break time="0.5s"/>
I'm [Name], and I'll guide you through everything you need to know. <break time="1s"/>

By the end of this video, you'll be able to [outcome 1], [outcome 2], and [outcome 3]. <break time="1s"/>

Let's start with the basics. <break time="1.5s"/>

[Section 1 content - 2-3 sentences] <break time="1s"/>

Now that you understand [concept], let's move on to [next topic]. <break time="1.5s"/>

[Section 2 content - 2-3 sentences] <break time="1s"/>

And finally, let's cover [last topic]. <break time="1.5s"/>

[Section 3 content - 2-3 sentences] <break time="1s"/>

That's everything you need to get started. <break time="0.5s"/>
If you have questions, leave a comment below. <break time="0.5s"/>
Thanks for watching!
`;
```

### Announcement (30 seconds, ~75 words)

```typescript
const announcement = `
Big news! <break time="0.5s"/>

We're thrilled to announce [announcement]. <break time="1s"/>

This means [benefit 1] and [benefit 2] for all our users. <break time="0.5s"/>

Starting [date], you'll be able to [new capability]. <break time="1s"/>

Head to [location] to learn more. <break time="0.5s"/>
We can't wait to hear what you think!
`;
```

## Writing Tips for AI Voices

### Do

- **Write conversationally** - Read it aloud to check flow
- **Use contractions** - "We're" not "We are", "It's" not "It is"
- **Break up long sentences** - Split at natural pause points
- **Spell out abbreviations** - "API" may sound like "a pee eye"
- **Add pauses for emphasis** - Guide the listener's attention
- **End sections clearly** - Don't trail off mid-thought

### Avoid

- **Jargon without context** - Explain technical terms
- **Long parentheticals** - Move to separate sentences
- **Ambiguous pronunciations** - "read" (present) vs "read" (past)
- **Excessive exclamation marks** - One per script is usually enough
- **Run-on sentences** - Break into digestible chunks
- **Dense information** - Space out facts with pauses

### Pronunciation Hints

For words that might be mispronounced, spell phonetically or add hints:

```typescript
// Technical terms
const script1 = "Our API (A-P-I) handles authentication...";

// Ambiguous words
const script2 = "I read (red) the documentation yesterday...";

// Brand names
const script3 = "Welcome to HeyGen (hey-jen)...";
```

## Multi-Scene Scripts

When splitting scripts across scenes (for different backgrounds or avatars):

```typescript
const multiSceneVideo = {
  video_inputs: [
    {
      // Scene 1: Introduction
      character: { type: "avatar", avatar_id: "josh_lite3_20230714", avatar_style: "normal" },
      voice: {
        type: "text",
        input_text: "Welcome to our quarterly update. <break time=\"1s\"/> I'm Josh, and I'll walk you through the highlights.",
        voice_id: "voice_id_here",
      },
      background: { type: "color", value: "#1a1a2e" },
    },
    {
      // Scene 2: Main content (different background)
      character: { type: "avatar", avatar_id: "josh_lite3_20230714", avatar_style: "normal" },
      voice: {
        type: "text",
        input_text: "Let's start with revenue. <break time=\"0.5s\"/> We grew 25 percent quarter over quarter. <break time=\"1s\"/> Here's what drove that growth.",
        voice_id: "voice_id_here",
      },
      background: { type: "image", url: "https://..." },
    },
    // ... more scenes
  ],
};
```

### Scene Transition Tips

- End each scene with a complete thought
- Start new scenes with brief context
- Maintain consistent tone across scenes
- Use pauses at scene starts to let visuals register

## Testing Your Script

Before generating the full video:

1. **Read aloud** - Time yourself, check for awkward phrasing
2. **Count words** - Verify expected duration
3. **Check break tags** - Ensure proper spacing and syntax
4. **Preview with short clip** - Generate a 10-second test if unsure about pronunciation

```typescript
// Test a small portion first
const testScript = script.split('.').slice(0, 2).join('.') + '.';
const testVideoId = await generateVideo({
  video_inputs: [{
    character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
    voice: { type: "text", input_text: testScript, voice_id: voiceId },
  }],
  dimension: { width: 1280, height: 720 }, // Lower res for test
});
```

## Voice Speed Adjustment

Adjust delivery speed in the voice configuration:

```typescript
voice: {
  type: "text",
  input_text: script,
  voice_id: "voice_id",
  speed: 1.1,  // Slightly faster (range: 0.5 - 2.0)
}
```

| Speed | Effect | Use Case |
|-------|--------|----------|
| 0.8-0.9 | Slower, deliberate | Complex topics, older audiences |
| 1.0 | Normal | General use |
| 1.1-1.2 | Slightly faster | Energetic content, younger audiences |
| 1.3+ | Fast | Use sparingly, may reduce clarity |

See [voices.md](voices.md) for full voice configuration options.
