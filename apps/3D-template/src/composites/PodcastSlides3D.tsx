import React from "react";
import { AbsoluteFill } from "remotion";
import { LinkedParticles } from "../scenes/LinkedParticles";
import { PodcastSlides } from "@app/remotion3/scenes/PodcastSlides";

type Props = React.ComponentProps<typeof PodcastSlides>;

export const PodcastSlides3D: React.FC<Props> = (props) => {
  return (
    <AbsoluteFill>
      {/* Live 3D background */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        <LinkedParticles showGUI={false} seed="PodcastSlides3D" />
      </div>
      {/* Scrim overlay to improve foreground readability over 3D background (slightly lighter to let animation pop) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          background:
            "radial-gradient(60% 60% at 50% 50%, rgba(0,0,0,0.45), rgba(0,0,0,0.20) 40%, rgba(0,0,0,0.10) 70%, rgba(0,0,0,0) 100%)",
        }}
      />
      {/* Bottom scrim for subtitles area */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 240,
          zIndex: 1,
          pointerEvents: "none",
          background:
            "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 80%)",
        }}
      />
      <AbsoluteFill style={{ zIndex: 2 }}>
        <PodcastSlides {...props} transparentBg={true} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export default PodcastSlides3D;
