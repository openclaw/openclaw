import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, interpolate, useCurrentFrame } from "remotion";
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

export const NewsVideo: React.FC<VideoProps> = ({
  slides,
  audioPath,
  words,
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

      {/* Slides with fade transitions */}
      {slides.map((slide, i) => {
        const from = frameOffset;
        frameOffset += slide.durationFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={slide.durationFrames}>
            <FadeSlide durationInFrames={slide.durationFrames}>
              {renderSlide(slide, i, slides.length)}
            </FadeSlide>
          </Sequence>
        );
      })}

      {/* Word-level captions overlay */}
      {words.length > 0 && <WordCaption words={words} />}
    </AbsoluteFill>
  );
};
