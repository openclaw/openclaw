import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  staticFile,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { IntroSlide } from "./components/IntroSlide";
import { OutroSlide } from "./components/OutroSlide";
import { StorySlide } from "./components/StorySlide";
import { WordCaption } from "./components/WordCaption";
import type { VideoProps, SlideData } from "./types";

function parseBody(body: string | string[]): string[] {
  if (Array.isArray(body)) return body;
  return body
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

function getSource(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

function renderSlide(slide: SlideData, index: number, total: number): React.ReactNode {
  const bullets = parseBody(slide.body);

  switch (slide.slideType) {
    case "intro":
    case "title":
      return (
        <IntroSlide
          title={slide.title}
          bullets={bullets}
          date={new Date().toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
          slideIndex={index}
          totalSlides={total}
        />
      );
    case "story":
    case "step":
      return (
        <StorySlide
          title={slide.title}
          bullets={bullets}
          source={getSource(slide.sourceUrl)}
          slideIndex={index}
          totalSlides={total}
        />
      );
    case "outro":
      return (
        <OutroSlide title={slide.title} bullets={bullets} slideIndex={index} totalSlides={total} />
      );
    default:
      return (
        <StorySlide
          title={slide.title}
          bullets={bullets}
          source={getSource(slide.sourceUrl)}
          slideIndex={index}
          totalSlides={total}
        />
      );
  }
}

/** Fade wrapper for slide transitions */
const FadeSlide: React.FC<{ children: React.ReactNode; durationInFrames: number }> = ({
  children,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [durationInFrames - 15, durationInFrames], [1, 0], {
    extrapolateRight: "clamp",
  });
  return <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>{children}</AbsoluteFill>;
};

/** A glassmorphic chip showing the slide title — overlaid on B-roll backgrounds. */
const TitleChip: React.FC<{ title: string }> = ({ title }) => {
  if (!title) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 80,
        left: 80,
        padding: "20px 36px",
        background: "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: 16,
        border: "1px solid rgba(255,255,255,0.18)",
        maxWidth: "70%",
      }}
    >
      <div
        style={{
          fontFamily: "Helvetica, sans-serif",
          fontWeight: 800,
          color: "white",
          fontSize: 64,
          lineHeight: 1.1,
          letterSpacing: -1,
          textShadow: "0 4px 24px rgba(0,0,0,0.6)",
        }}
      >
        {title}
      </div>
    </div>
  );
};

/** B-roll background slide: full-bleed video + dark vignette + title chip. */
const BrollSlide: React.FC<{ brollPath: string; title: string }> = ({ brollPath, title }) => {
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile(brollPath)} muted />
      {/* Dark gradient at top + bottom for caption + title readability */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 25%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.7) 100%)",
        }}
      />
      <TitleChip title={title} />
    </AbsoluteFill>
  );
};

export const NewsVideo: React.FC<VideoProps> = ({
  slides,
  audioPath,
  words,
  brollPaths,
  musicPath,
  musicVolume = 0.15,
}) => {
  // Calculate frame offsets for each slide
  let frameOffset = 0;

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {/* Narration audio — must be in public/ for Remotion */}
      {audioPath && <Audio src={staticFile(audioPath)} volume={1} />}

      {/* Background music */}
      {musicPath && <Audio src={staticFile(musicPath)} volume={musicVolume} loop />}

      {/* Slides with fade transitions. If a per-slide brollPath is provided,
          render the b-roll clip as a full-bleed background with a title chip;
          otherwise fall back to the branded slide components. */}
      {slides.map((slide, i) => {
        const from = frameOffset;
        frameOffset += slide.durationFrames;
        const brollPath = brollPaths?.[i];
        return (
          <Sequence key={i} from={from} durationInFrames={slide.durationFrames}>
            <FadeSlide durationInFrames={slide.durationFrames}>
              {brollPath ? (
                <BrollSlide brollPath={brollPath} title={slide.title} />
              ) : (
                renderSlide(slide, i, slides.length)
              )}
            </FadeSlide>
          </Sequence>
        );
      })}

      {/* Word-level captions overlay (works for both slide modes) */}
      {words.length > 0 && <WordCaption words={words} />}
    </AbsoluteFill>
  );
};
