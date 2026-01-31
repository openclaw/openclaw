# Complete Example: User Management Module

## Routes (Adapter Layer)

```python
# adapter/routes/user_routes.py
from flask import Blueprint, request, jsonify
from client.dto.command.user_add_cmd import UserAddCmd
from client.dto.query.user_list_qry import UserListQry
from client.dto.co.user_co import UserCO

# Dependency injection
from infrastructure.gateway_impl.user_gateway_impl import UserGatewayImpl
from infrastructure.convertor.user_convertor import UserConvertor
from application.command.user_add_cmd_exe import UserAddCmdExe
from application.query.user_list_qry_exe import UserListQryExe
from application.service.user_service import UserService

user_gateway = UserGatewayImpl()
convertor = UserConvertor()
user_add_cmd_exe = UserAddCmdExe(user_gateway)
user_list_qry_exe = UserListQryExe(user_gateway, convertor)
user_service = UserService(user_add_cmd_exe, user_list_qry_exe)

user_bp = Blueprint('user', __name__, url_prefix='/api/users')

@user_bp.route('', methods=['POST'])
def add_user():
    data = request.get_json()
    user_co = UserCO(name=data.get('name', ''), email=data.get('email', ''))
    cmd = UserAddCmd(user_co=user_co)
    response = user_service.add_user(cmd)
    return jsonify({"success": response.success, "errCode": response.err_code, "errMessage": response.err_message})

@user_bp.route('', methods=['GET'])
def list_users():
    qry = UserListQry(
        keyword=request.args.get('keyword'),
        page_index=int(request.args.get('page', 1)),
        page_size=int(request.args.get('size', 10)),
    )
    response = user_service.list_users(qry)
    return jsonify({"success": response.success, "data": [vars(co) for co in response.data]})
```

## Data Models (Infrastructure)

```python
# infrastructure/repository/models.py
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class UserDO(db.Model):
    __tablename__ = 'users'
    
    id = db.Column(db.String(36), primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(100), unique=True, nullable=False)
    status = db.Column(db.String(20), default='active')
```

## Application Entry Point

```python
# app.py
from flask import Flask
from infrastructure.repository.models import db
from adapter.routes.user_routes import user_bp

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///app.db'

db.init_app(app)
app.register_blueprint(user_bp)

with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(debug=True)
```

## Directory Structure

```
project/
├── adapter/
│   ├── __init__.py
│   └── routes/
│       ├── __init__.py
│       └── user_routes.py
├── application/
│   ├── __init__.py
│   ├── command/
│   │   ├── __init__.py
│   │   └── user_add_cmd_exe.py
│   ├── query/
│   │   ├── __init__.py
│   │   └── user_list_qry_exe.py
│   └── service/
│       ├── __init__.py
│       └── user_service.py
├── client/
│   ├── __init__.py
│   ├── api/
│   │   ├── __init__.py
│   │   └── user_service_i.py
│   └── dto/
│       ├── __init__.py
│       ├── response.py
│       ├── command/
│       │   ├── __init__.py
│       │   └── user_add_cmd.py
│       ├── query/
│       │   ├── __init__.py
│       │   └── user_list_qry.py
│       └── co/
│           ├── __init__.py
│           └── user_co.py
├── domain/
│   ├── __init__.py
│   ├── user/
│   │   ├── __init__.py
│   │   └── entity.py
│   └── gateway/
│       ├── __init__.py
│       └── user_gateway.py
├── infrastructure/
│   ├── __init__.py
│   ├── gateway_impl/
│   │   ├── __init__.py
│   │   └── user_gateway_impl.py
│   ├── convertor/
│   │   ├── __init__.py
│   │   └── user_convertor.py
│   └── repository/
│       ├── __init__.py
│       └── models.py
└── app.py
```
