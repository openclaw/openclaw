#!/usr/bin/env python3
"""
散步思考记录系统 - 测试脚本
用于测试系统各个组件是否正常工作
"""

import os
import sys
import subprocess
from pathlib import Path

def test_transcription():
    """测试语音转录功能"""
    print("🔊 测试语音转录功能...")
    
    # 创建一个测试音频文件（静音）
    test_audio = Path("/tmp/test_audio.wav")
    
    # 使用ffmpeg创建1秒的静音音频
    try:
        result = subprocess.run(
            ["ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", 
             "-t", "1", "-acodec", "pcm_s16le", str(test_audio)],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            print("❌ 无法创建测试音频文件")
            print(f"错误: {result.stderr}")
            return False
        
        # 测试转录
        transcribe_script = Path(__file__).parent / "transcribe.py"
        result = subprocess.run(
            [sys.executable, str(transcribe_script), str(test_audio)],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            print("✅ 语音转录功能正常")
            return True
        else:
            print("❌ 语音转录失败")
            print(f"错误: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"❌ 测试过程中出错: {str(e)}")
        return False
    finally:
        # 清理测试文件
        if test_audio.exists():
            test_audio.unlink()

def test_auto_process():
    """测试自动化处理功能"""
    print("🔄 测试自动化处理功能...")
    
    # 创建一个测试文本文件模拟转录结果
    test_dir = Path("/tmp/walking_thoughts_test")
    test_dir.mkdir(exist_ok=True)
    
    test_transcript = test_dir / "test_transcript.txt"
    test_transcript.write_text("这是一个测试转录内容。")
    
    test_audio = test_dir / "test_audio.ogg"
    test_audio.write_text("dummy audio file")  # 创建虚拟文件
    
    try:
        auto_process_script = Path(__file__).parent / "auto_process.py"
        result = subprocess.run(
            [sys.executable, str(auto_process_script), str(test_audio), 
             "--source", "test", "--timestamp", "2026-02-05_120000"],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            print("✅ 自动化处理功能正常")
            return True
        else:
            print("❌ 自动化处理失败")
            print(f"错误: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"❌ 测试过程中出错: {str(e)}")
        return False
    finally:
        # 清理测试目录
        import shutil
        if test_dir.exists():
            shutil.rmtree(test_dir)

def test_monthly_report():
    """测试月度报告功能"""
    print("📊 测试月度报告功能...")
    
    try:
        monthly_script = Path(__file__).parent / "monthly_report.py"
        result = subprocess.run(
            [sys.executable, str(monthly_script), "--force"],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            print("✅ 月度报告功能正常")
            return True
        else:
            print("❌ 月度报告生成失败")
            print(f"错误: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"❌ 测试过程中出错: {str(e)}")
        return False

def check_dependencies():
    """检查依赖项"""
    print("🔍 检查系统依赖项...")
    
    dependencies = [
        ("python3", ["--version"]),
        ("ffmpeg", ["-version"]),
        ("pip", ["--version"])
    ]
    
    all_ok = True
    for cmd, args in dependencies:
        try:
            result = subprocess.run(
                [cmd] + args,
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                print(f"✅ {cmd} 已安装")
            else:
                print(f"❌ {cmd} 未正确安装")
                all_ok = False
        except FileNotFoundError:
            print(f"❌ {cmd} 未安装")
            all_ok = False
    
    return all_ok

def main():
    """主测试函数"""
    print("=" * 50)
    print("散步思考记录系统 - 完整性测试")
    print("=" * 50)
    
    tests = [
        ("依赖项检查", check_dependencies),
        ("语音转录测试", test_transcription),
        ("自动化处理测试", test_auto_process),
        ("月度报告测试", test_monthly_report)
    ]
    
    results = []
    for test_name, test_func in tests:
        print(f"\n📋 执行测试: {test_name}")
        success = test_func()
        results.append((test_name, success))
    
    # 打印总结
    print("\n" + "=" * 50)
    print("测试总结:")
    print("=" * 50)
    
    passed = sum(1 for _, success in results if success)
    total = len(results)
    
    for test_name, success in results:
        status = "✅ 通过" if success else "❌ 失败"
        print(f"{test_name}: {status}")
    
    print(f"\n总测试: {total} 个，通过: {passed} 个，失败: {total - passed} 个")
    
    if passed == total:
        print("\n🎉 所有测试通过！系统运行正常。")
        return 0
    else:
        print("\n⚠️  部分测试失败，请检查系统配置。")
        return 1

if __name__ == "__main__":
    sys.exit(main())