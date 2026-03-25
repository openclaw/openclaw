/**
 * rapid-generator.ts
 * Advanced RAPID Code Generator for ABB Robots
 * Supports joint movements, linear movements, circular movements, and continuous trajectories
 */

export interface JointTarget {
  joints: number[];
  speed?: number;
  zone?: string;
}

export interface CartesianTarget {
  x: number;
  y: number;
  z: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  speed?: number;
  zone?: string;
}

export interface CircularTarget {
  via: CartesianTarget;
  to: CartesianTarget;
  speed?: number;
  zone?: string;
}

export interface TrajectoryPoint {
  type: "joint" | "linear" | "circular";
  target: JointTarget | CartesianTarget | CircularTarget;
}

/**
 * RAPID Code Generator
 */
export class RAPIDGenerator {
  private static formatSpeedData(speed: number): string {
    const tcp = Math.max(1, Math.min(7000, Number(speed) || 100));
    const tcpText = tcp.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    return `[${tcpText},500,5000,1000]`;
  }

  /**
   * Generate RAPID code for single joint movement
   */
  static generateMoveJoint(joints: number[], speed: number = 100, zone: string = "fine"): string {
    const jointsStr = joints.map(j => j.toFixed(2)).join(", ");
    const speedStr = this.formatSpeedData(speed);

    return `MODULE OpenClawMotionMod
  PROC AgentMoveProc()
    ! Move to joint position
    MoveAbsJ [[${jointsStr}], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]], ${speedStr}, ${zone}, tool0;
  ENDPROC
ENDMODULE`;
  }

  /**
   * Generate RAPID code for linear movement
   */
  static generateMoveLinear(target: CartesianTarget): string {
    const { x, y, z, q1, q2, q3, q4 } = target;
    const speed = target.speed || 100;
    const zone = target.zone || "fine";
    const speedStr = this.formatSpeedData(speed);

    return `MODULE OpenClawMotionMod
  CONST robtarget pTarget := [[${x}, ${y}, ${z}], [${q1}, ${q2}, ${q3}, ${q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  
  PROC AgentMoveProc()
    ! Linear movement to target
    MoveL pTarget, ${speedStr}, ${zone}, tool0;
  ENDPROC
ENDMODULE`;
  }

  /**
   * Generate RAPID code for circular movement
   */
  static generateMoveCircular(circular: CircularTarget): string {
    const { via, to } = circular;
    const speed = circular.speed || 100;
    const zone = circular.zone || "fine";
    const speedStr = this.formatSpeedData(speed);

    return `MODULE OpenClawMotionMod
  CONST robtarget pVia := [[${via.x}, ${via.y}, ${via.z}], [${via.q1}, ${via.q2}, ${via.q3}, ${via.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pTo := [[${to.x}, ${to.y}, ${to.z}], [${to.q1}, ${to.q2}, ${to.q3}, ${to.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  
  PROC AgentMoveProc()
    ! Circular movement via intermediate point
    MoveC pVia, pTo, ${speedStr}, ${zone}, tool0;
  ENDPROC
ENDMODULE`;
  }

  /**
   * Generate RAPID code for continuous trajectory
   */
  static generateTrajectory(points: TrajectoryPoint[], moduleName: string = "OpenClawMotionMod"): string {
    const declarations: string[] = [];
    const movements: string[] = [];

    points.forEach((point, index) => {
      if (point.type === "joint") {
        const target = point.target as JointTarget;
        const jointsStr = target.joints.map(j => j.toFixed(2)).join(", ");
        const speed = target.speed || 100;
        const zone = target.zone || (index === points.length - 1 ? "fine" : "z10");
        
        declarations.push(`  CONST jointtarget jTarget${index} := [[${jointsStr}], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];`);
        movements.push(`    MoveAbsJ jTarget${index}, ${this.formatSpeedData(speed)}, ${zone}, tool0;`);
      } else if (point.type === "linear") {
        const target = point.target as CartesianTarget;
        const { x, y, z, q1, q2, q3, q4 } = target;
        const speed = target.speed || 100;
        const zone = target.zone || (index === points.length - 1 ? "fine" : "z10");
        
        declarations.push(`  CONST robtarget pTarget${index} := [[${x}, ${y}, ${z}], [${q1}, ${q2}, ${q3}, ${q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];`);
        movements.push(`    MoveL pTarget${index}, ${this.formatSpeedData(speed)}, ${zone}, tool0;`);
      } else if (point.type === "circular") {
        const circular = point.target as CircularTarget;
        const { via, to } = circular;
        const speed = circular.speed || 100;
        const zone = circular.zone || (index === points.length - 1 ? "fine" : "z10");
        
        declarations.push(`  CONST robtarget pVia${index} := [[${via.x}, ${via.y}, ${via.z}], [${via.q1}, ${via.q2}, ${via.q3}, ${via.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];`);
        declarations.push(`  CONST robtarget pTo${index} := [[${to.x}, ${to.y}, ${to.z}], [${to.q1}, ${to.q2}, ${to.q3}, ${to.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];`);
        movements.push(`    MoveC pVia${index}, pTo${index}, ${this.formatSpeedData(speed)}, ${zone}, tool0;`);
      }
    });

    return `MODULE ${moduleName}
${declarations.join("\n")}
  
  PROC AgentMoveProc()
    ! Continuous trajectory with ${points.length} points
${movements.join("\n")}
  ENDPROC
ENDMODULE`;
  }

  /**
   * Generate RAPID code for pick and place operation
   */
  static generatePickAndPlace(
    pickPos: CartesianTarget,
    placePos: CartesianTarget,
    approachOffset: number = 100,
    speed: number = 100
  ): string {
    const pickApproach = { ...pickPos, z: pickPos.z + approachOffset };
    const placeApproach = { ...placePos, z: placePos.z + approachOffset };

    const travelSpeedData = this.formatSpeedData(speed);
    const approachSpeedData = this.formatSpeedData(speed / 2);

    return `MODULE PickAndPlace
  CONST robtarget pPickApproach := [[${pickApproach.x}, ${pickApproach.y}, ${pickApproach.z}], [${pickApproach.q1}, ${pickApproach.q2}, ${pickApproach.q3}, ${pickApproach.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pPick := [[${pickPos.x}, ${pickPos.y}, ${pickPos.z}], [${pickPos.q1}, ${pickPos.q2}, ${pickPos.q3}, ${pickPos.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pPlaceApproach := [[${placeApproach.x}, ${placeApproach.y}, ${placeApproach.z}], [${placeApproach.q1}, ${placeApproach.q2}, ${placeApproach.q3}, ${placeApproach.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pPlace := [[${placePos.x}, ${placePos.y}, ${placePos.z}], [${placePos.q1}, ${placePos.q2}, ${placePos.q3}, ${placePos.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  
  PROC main()
    ! Pick and place operation
    MoveL pPickApproach, ${travelSpeedData}, z10, tool0;
    MoveL pPick, ${approachSpeedData}, fine, tool0;
    ! Close gripper here
    WaitTime 0.5;
    MoveL pPickApproach, ${travelSpeedData}, z10, tool0;
    MoveL pPlaceApproach, ${travelSpeedData}, z10, tool0;
    MoveL pPlace, ${approachSpeedData}, fine, tool0;
    ! Open gripper here
    WaitTime 0.5;
    MoveL pPlaceApproach, ${travelSpeedData}, z10, tool0;
  ENDPROC
ENDMODULE`;
  }

  /**
   * Generate RAPID code for welding path
   */
  static generateWeldingPath(
    startPos: CartesianTarget,
    endPos: CartesianTarget,
    weldSpeed: number = 10,
    travelSpeed: number = 100
  ): string {
    const approachStart = { ...startPos, z: startPos.z + 50 };
    const approachEnd = { ...endPos, z: endPos.z + 50 };

    const travelSpeedData = this.formatSpeedData(travelSpeed);
    const halfTravelSpeedData = this.formatSpeedData(travelSpeed / 2);
    const weldSpeedData = this.formatSpeedData(weldSpeed);

    return `MODULE Welding
  CONST robtarget pApproachStart := [[${approachStart.x}, ${approachStart.y}, ${approachStart.z}], [${approachStart.q1}, ${approachStart.q2}, ${approachStart.q3}, ${approachStart.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pWeldStart := [[${startPos.x}, ${startPos.y}, ${startPos.z}], [${startPos.q1}, ${startPos.q2}, ${startPos.q3}, ${startPos.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pWeldEnd := [[${endPos.x}, ${endPos.y}, ${endPos.z}], [${endPos.q1}, ${endPos.q2}, ${endPos.q3}, ${endPos.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  CONST robtarget pApproachEnd := [[${approachEnd.x}, ${approachEnd.y}, ${approachEnd.z}], [${approachEnd.q1}, ${approachEnd.q2}, ${approachEnd.q3}, ${approachEnd.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
  
  PROC main()
    ! Welding path
    MoveL pApproachStart, ${travelSpeedData}, z10, tool0;
    MoveL pWeldStart, ${halfTravelSpeedData}, fine, tool0;
    ! Start welding
    SetDO doWeldOn, 1;
    MoveL pWeldEnd, ${weldSpeedData}, fine, tool0;
    ! Stop welding
    SetDO doWeldOn, 0;
    MoveL pApproachEnd, ${travelSpeedData}, z10, tool0;
  ENDPROC
ENDMODULE`;
  }

  /**
   * Generate RAPID code for palletizing pattern
   */
  static generatePalletizing(
    basePos: CartesianTarget,
    rows: number,
    cols: number,
    layers: number,
    spacing: { x: number; y: number; z: number },
    speed: number = 100
  ): string {
    const declarations: string[] = [];
    const movements: string[] = [];

    let index = 0;
    for (let layer = 0; layer < layers; layer++) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = basePos.x + col * spacing.x;
          const y = basePos.y + row * spacing.y;
          const z = basePos.z + layer * spacing.z;
          
          declarations.push(`  CONST robtarget pPallet${index} := [[${x}, ${y}, ${z}], [${basePos.q1}, ${basePos.q2}, ${basePos.q3}, ${basePos.q4}], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];`);
          movements.push(`    MoveL pPallet${index}, ${this.formatSpeedData(speed)}, z10, tool0;`);
          movements.push(`    ! Place object here`);
          movements.push(`    WaitTime 0.5;`);
          
          index++;
        }
      }
    }

    return `MODULE Palletizing
${declarations.join("\n")}
  
  PROC main()
    ! Palletizing pattern: ${rows}x${cols}x${layers}
${movements.join("\n")}
  ENDPROC
ENDMODULE`;
  }
}
