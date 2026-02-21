"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, useMemo } from "react";
import * as THREE from "three";

function HexGrid() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = 200;

  const hexPositions = useMemo(() => {
    const positions: { x: number; y: number; z: number; delay: number }[] = [];
    const hexW = 1.8;
    const hexH = 1.56;
    const cols = 20;
    const rows = 10;
    for (let row = -rows; row <= rows; row++) {
      for (let col = -cols; col <= cols; col++) {
        if (positions.length >= count) break;
        const x = col * hexW + (row % 2 === 0 ? 0 : hexW / 2);
        const y = row * hexH;
        const z = -5 + Math.random() * 2;
        const delay = Math.sqrt(x * x + y * y) * 0.1;
        positions.push({ x, y, z, delay });
      }
    }
    return positions.slice(0, count);
  }, []);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    hexPositions.forEach((pos, i) => {
      dummy.position.set(pos.x, pos.y, pos.z + Math.sin(t * 0.5 + pos.delay) * 0.3);
      dummy.rotation.set(0, 0, Math.PI / 6);
      const scale = 0.85 + Math.sin(t * 0.3 + pos.delay) * 0.1;
      dummy.scale.set(scale, scale, 1);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  const hexShape = useMemo(() => {
    const shape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const x = Math.cos(angle) * 0.8;
      const y = Math.sin(angle) * 0.8;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    return shape;
  }, []);

  const geometry = useMemo(() => {
    const geo = new THREE.ShapeGeometry(hexShape);
    const edgesGeo = new THREE.EdgesGeometry(geo);
    return edgesGeo;
  }, [hexShape]);

  // Use line segments for wireframe hexagons
  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <shapeGeometry args={[hexShape]} />
      <meshBasicMaterial color="#f59e0b" transparent opacity={0.04} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

function HexEdges() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = 80;

  const hexPositions = useMemo(() => {
    const positions: { x: number; y: number; z: number; delay: number }[] = [];
    const hexW = 1.8;
    const hexH = 1.56;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(Math.random() * 20) - 10;
      const col = Math.floor(Math.random() * 40) - 20;
      const x = col * hexW + (row % 2 === 0 ? 0 : hexW / 2);
      const y = row * hexH;
      const z = -4 + Math.random() * 2;
      const delay = Math.sqrt(x * x + y * y) * 0.1;
      positions.push({ x, y, z, delay });
    }
    return positions;
  }, []);

  const ringShape = useMemo(() => {
    const outer = new THREE.Shape();
    const inner = new THREE.Path();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const ox = Math.cos(angle) * 0.82;
      const oy = Math.sin(angle) * 0.82;
      const ix = Math.cos(angle) * 0.76;
      const iy = Math.sin(angle) * 0.76;
      if (i === 0) {
        outer.moveTo(ox, oy);
        inner.moveTo(ix, iy);
      } else {
        outer.lineTo(ox, oy);
        inner.lineTo(ix, iy);
      }
    }
    outer.closePath();
    inner.closePath();
    outer.holes.push(inner);
    return outer;
  }, []);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    hexPositions.forEach((pos, i) => {
      dummy.position.set(pos.x, pos.y, pos.z + Math.sin(t * 0.5 + pos.delay) * 0.3);
      dummy.rotation.set(0, 0, Math.PI / 6);
      dummy.scale.setScalar(0.85 + Math.sin(t * 0.3 + pos.delay) * 0.1);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <shapeGeometry args={[ringShape]} />
      <meshBasicMaterial color="#f59e0b" transparent opacity={0.06} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

function FloatingParticles() {
  const pointsRef = useRef<THREE.Points>(null);
  const count = 80;

  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 40;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 20;
      arr[i * 3 + 2] = -3 + Math.random() * 3;
    }
    return arr;
  }, []);

  useFrame((state) => {
    if (!pointsRef.current) return;
    pointsRef.current.rotation.z = state.clock.elapsedTime * 0.01;
    const posArr = pointsRef.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < count; i++) {
      posArr[i * 3 + 1] += Math.sin(state.clock.elapsedTime * 0.3 + i) * 0.002;
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} count={count} />
      </bufferGeometry>
      <pointsMaterial color="#fbbf24" size={0.04} transparent opacity={0.6} sizeAttenuation />
    </points>
  );
}

function QueenNode() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    meshRef.current.rotation.z = t * 0.2;
    meshRef.current.scale.setScalar(1 + Math.sin(t * 0.8) * 0.05);
  });

  const hexShape = useMemo(() => {
    const shape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const x = Math.cos(angle) * 1.2;
      const y = Math.sin(angle) * 1.2;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    return shape;
  }, []);

  return (
    <mesh ref={meshRef} position={[0, 0, -2]}>
      <shapeGeometry args={[hexShape]} />
      <meshBasicMaterial color="#f59e0b" transparent opacity={0.08} />
    </mesh>
  );
}

export function HoneycombScene() {
  return (
    <div className="absolute inset-0 -z-10">
      <Canvas
        camera={{ position: [0, 0, 10], fov: 60 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <HexGrid />
        <HexEdges />
        <FloatingParticles />
        <QueenNode />
      </Canvas>
    </div>
  );
}
