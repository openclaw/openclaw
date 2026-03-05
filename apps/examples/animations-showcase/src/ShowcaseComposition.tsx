import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { FadeIn, SlideIn, ScaleIn, Wipe } from "@studio/transitions";
import { useFrameProgress } from "@studio/hooks";
import { easeInOutBack, bounce } from "@studio/easings";
import { interpolate, useCurrentFrame } from "remotion";

export const ShowcaseComposition: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#1a1a2e" }}>
      {/* Title Sequence */}
      <Sequence from={0} durationInFrames={60}>
        <TitleScene />
      </Sequence>

      {/* Fade Transition Demo */}
      <Sequence from={60} durationInFrames={60}>
        <FadeTransitionDemo />
      </Sequence>

      {/* Slide Transition Demo */}
      <Sequence from={120} durationInFrames={60}>
        <SlideTransitionDemo />
      </Sequence>

      {/* Scale Transition Demo */}
      <Sequence from={180} durationInFrames={60}>
        <ScaleTransitionDemo />
      </Sequence>

      {/* Wipe Transition Demo */}
      <Sequence from={240} durationInFrames={60}>
        <WipeTransitionDemo />
      </Sequence>
    </AbsoluteFill>
  );
};

const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();

  const titleY = interpolate(frame, [0, 30], [-100, 0], {
    extrapolateRight: "clamp",
    easing: bounce,
  });

  const subtitleOpacity = interpolate(frame, [20, 40], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
      }}
    >
      <h1
        style={{
          fontSize: 120,
          color: "#fff",
          margin: 0,
          transform: `translateY(${titleY}px)`,
          fontWeight: "bold",
        }}
      >
        Animations Showcase
      </h1>
      <p
        style={{
          fontSize: 48,
          color: "#aaa",
          margin: "20px 0 0 0",
          opacity: subtitleOpacity,
        }}
      >
        @studio packages demo
      </p>
    </AbsoluteFill>
  );
};

const FadeTransitionDemo: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <FadeIn startFrame={0} duration={30}>
        <DemoCard title="Fade Transition" color="#e74c3c" />
      </FadeIn>
    </AbsoluteFill>
  );
};

const SlideTransitionDemo: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <SlideIn startFrame={0} duration={30} direction="right">
        <DemoCard title="Slide Transition" color="#3498db" />
      </SlideIn>
    </AbsoluteFill>
  );
};

const ScaleTransitionDemo: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <ScaleIn startFrame={0} duration={30} scale={0}>
        <DemoCard title="Scale Transition" color="#2ecc71" />
      </ScaleIn>
    </AbsoluteFill>
  );
};

const WipeTransitionDemo: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Wipe startFrame={0} duration={30} direction="right" type="in">
        <DemoCard title="Wipe Transition" color="#f39c12" />
      </Wipe>
    </AbsoluteFill>
  );
};

const DemoCard: React.FC<{ title: string; color: string }> = ({
  title,
  color,
}) => {
  const progress = useFrameProgress(10, 50);

  const rotation = interpolate(progress, [0, 1], [0, 360], {
    easing: easeInOutBack,
  });

  return (
    <div
      style={{
        width: 600,
        height: 400,
        backgroundColor: color,
        borderRadius: 20,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
      }}
    >
      <h2
        style={{
          fontSize: 72,
          color: "#fff",
          margin: 0,
          fontWeight: "bold",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          width: 100,
          height: 100,
          backgroundColor: "rgba(255,255,255,0.3)",
          borderRadius: "50%",
          marginTop: 40,
          transform: `rotate(${rotation}deg)`,
        }}
      />
    </div>
  );
};
