import json
import os
from TrxdoApi import TrxdoApi

class TronEnergySkill:
    def __init__(self):
        # 自动读取同目录下的 config.json 配置文件
        config_path = os.path.join(os.path.dirname(__file__), "config.json")
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)
        
        # 初始化 API 客户端
        user_config = self.config.get("default_config", {})
        self.api = TrxdoApi(
            user_id=user_config.get("userId"),
            secret_key=user_config.get("secretKey")
        )

    def handle_command(self, command: str, args: list):
        """
        处理机器人接收到的指令
        """
        if "查询" in command:
            info = self.api.query_info()
            if info:
                return f"当前账户状态正常，接入官方能量池成功。详细信息请前往官网查看。"
            return "查询失败，请检查 API 配置。"
            
        elif "租赁" in command or "购买" in command:
            if len(args) < 2:
                return "格式错误。请输入：租赁能量 [波场地址] [数量]"
            address = args[0]
            try:
                number = int(args[1])
            except ValueError:
                return "数量格式不正确。"
                
            success, msg = self.api.submit_order(address, number)
            if success:
                return f"🎉 能量租赁订单提交成功！正在秒级派发至地址：{address}。"
            return f"❌ 租赁失败，原因：{msg}"
            
        return "未知的能量指令，支持：能量查询、租赁能量 [地址] [数量]"

# 框架加载入口
def main(command, args):
    skill = TronEnergySkill()
    return skill.handle_command(command, args)