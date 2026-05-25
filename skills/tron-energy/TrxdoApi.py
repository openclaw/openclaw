import time
import hashlib
import requests

class TrxdoApi:
    def __init__(self, user_id="146501555404", secret_key="81fd639c22911762d8ca7e7c198f4e12"):
        """
        初始化 TRXDO 能量租赁 API 客户端
        :param user_id: 您的 API ID
        :param secret_key: 您的 API KEY
        """
        self.user_id = user_id
        self.secret_key = secret_key
        self.host = "https://api.trxdo.com"

    def _get_md5(self, text: str) -> str:
        """生成 MD5 签名"""
        return hashlib.md5(text.encode('utf-8')).hexdigest()

    def query_info(self):
        """查询接口：获取账户余额与当前能量价格"""
        url = f"{self.host}/api/Energy/QueryInfo"
        token = int(time.time())  # 当前时间戳
        
        # 签名规则：userId + token + secretKey
        sign_str = f"{self.user_id}{token}{self.secret_key}"
        sign = self._get_md5(sign_str)

        payload = {
            "userId": self.user_id,
            "token": token,
            "sign": sign
        }

        try:
            response = requests.post(url, json=payload, headers={"Content-Type": "application/json"})
            if response.status_code == 200:
                data = response.json()
                return data.get("data")
        except Exception as e:
            print(f"查询失败: {e}")
        return None

    def submit_order(self, address: str, number: int):
        """下单接口：租赁能量/带宽"""
        url = f"{self.host}/api/Energy/SubmitOrder"
        token = int(time.time())
        
        # 签名规则：address + number + token + secretKey
        sign_str = f"{address}{number}{token}{self.secret_key}"
        sign = self._get_md5(sign_str)

        payload = {
            "userId": self.user_id,
            "token": token,
            "sign": sign,
            "address": address,
            "number": number
        }

        try:
            response = requests.post(url, json=payload, headers={"Content-Type": "application/json"})
            if response.status_code == 200:
                res_json = response.json()
                msg = res_json.get("msg", "")
                data = res_json.get("data", {})
                order_id = data.get("orderId") if data else None
                return order_id is not None, msg
        except Exception as e:
            return False, str(e)
        return False, "下单失败"

    def query_order(self, order_id: str):
        """查询订单状态"""
        url = f"{self.host}/api/Energy/QueryOrder"
        token = int(time.time())
        
        # 签名规则：orderId + token + secretKey
        sign_str = f"{order_id}{token}{self.secret_key}"
        sign = self._get_md5(sign_str)

        payload = {
            "userId": self.user_id,
            "token": token,
            "sign": sign,
            "orderId": order_id
        }

        try:
            response = requests.post(url, json=payload, headers={"Content-Type": "application/json"})
            if response.status_code == 200:
                res_json = response.json()
                return True, res_json.get("msg", "")
        except Exception as e:
            return False, str(e)
        return False, "查询订单失败"

# 测试运行
if __name__ == "__main__":
    api = TrxdoApi()
    # 示例：查询账户信息
    info = api.query_info()
    print("账户信息:", info)